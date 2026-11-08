"""模型解析：把一封招聘邮件交给兼容 OpenAI 的接口，产出规范化的日程草稿。

只做「调用 + 校验」，不碰数据库；落库与待确认队列在 sync.py。
"""
from __future__ import annotations

import json
import re
import urllib.error
import urllib.request
from datetime import datetime, timedelta

from . import config, events

TIMEOUT = 45
MAX_EVENTS = 20

SYSTEM_PROMPT = (
    "你是秋招邮件助手。请通读整封邮件（不能只看标题），只输出一个 JSON 对象，"
    "不要解释、不要 Markdown 代码块。\n"
    '结构：{"summary": "一句话概括邮件内容", "events": [事件对象]}\n'
    "events 只放需要你本人参加或完成的事项：面试、笔试、测评，"
    "包括 AI 面试、线上/线下面试、线上/线下笔试、在线测评、限时测评等各种形式。"
    "宣讲会、投递邀请、招聘开启、感谢投递、已收到投递、流程说明、结果反馈不要输出。\n"
    "不要替邮件归类：邮件里叫「测评」就写测评，不要自行判断它其实是笔试还是面试。"
    "判断也不能只看标题：很多「已收到投递」的邮件正文里会附测评链接和完成时限，"
    "只要正文里出现日期、时间、链接或截止要求，就要提取；没有就填 []。\n"
    "同一场活动只输出一个事件：如果邮件里既有面试/笔试的具体时间，"
    "又有确认预约、加群、提交材料的截止时间，合并成同一条。\n"
    "事件字段：company, position, round, start_date, start_time, "
    "end_date, end_time, mode, location, link, deadline, deadline_hours, note。\n"
    "round 填这件事的名称和形式，用邮件原文的措辞，如「AI 面试」「线上笔试」「线下终面」「在线测评」。\n"
    "company 必填，只填公司名。\n"
    "position 有就照抄邮件里的岗位名称，邮件没写就留空，不要编造。\n"
    "先判断每件事的实质和它的主体时间——主体时间是你本人参加或完成这件事的时间。\n"
    "主体时间是固定时段（如面试定在 11月9日 15:00）：填 start_date（YYYY-MM-DD）与 start_time（HH:MM，24 小时制），"
    "有结束时间再成对填 end_date/end_time，没有就留空；deadline 留空。\n"
    "这件事本身就是「在某时间前完成」（如在线测评、限时笔试、确认是否参加）：这个时间就是主体时间，"
    "不填 start_date/start_time，填进 deadline（YYYY-MM-DD HH:MM）；"
    "只说「收到邮件后 72 小时内完成」这类相对要求时，把小时数填进 deadline_hours（数字），deadline 留空。\n"
    "主体时间已确定后，邮件里另外提到的预约、改期、确认、加群、提交材料的截止都不是主体时间，"
    "不要填 deadline，合并成 note 里的一行，例如「11月10日 13:37 前可改期」。\n"
    "只知道日期、不知道具体钟点时 start_time 留空。\n"
    "mode 填 线上 或 线下；location 填线下地点，线上留空。\n"
    "note 只写必须照做的关键动作，简短、一目了然，不要复述邮件内容；"
    "有多项就每项单独一行（JSON 字符串里用 \\n 换行），例如「带简历」；"
    "没有特殊要求就写「无特殊要求」。\n"
    "既没有开始日期也没有截止时间的事件不要输出。"
    "没有明确日期时间时留空字符串，绝不编造。"
)


class ParseError(RuntimeError):
    pass


def _endpoint(base_url: str) -> str:
    url = (base_url or "").strip().rstrip("/")
    if not url:
        raise ParseError("还没填模型接口地址")
    if url.endswith("/chat/completions"):
        return url
    if re.search(r"/v\d+$", url):
        return url + "/chat/completions"
    return url + "/v1/chat/completions"


def _request(url: str, key: str, payload: dict) -> dict:
    body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(
        url,
        data=body,
        headers={
            "Content-Type": "application/json",
            "Authorization": "Bearer " + key,
        },
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=TIMEOUT) as resp:
            return json.loads(resp.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        detail = ""
        try:
            detail = exc.read().decode("utf-8", "replace")[:300]
        except Exception:
            pass
        raise ParseError(f"模型接口返回 {exc.code}：{detail or exc.reason}")
    except urllib.error.URLError as exc:
        raise ParseError(f"连不上模型接口：{exc.reason}")
    except (ValueError, json.JSONDecodeError):
        raise ParseError("模型接口返回的不是 JSON")


def _content(data: dict) -> str:
    try:
        return data["choices"][0]["message"]["content"] or ""
    except (KeyError, IndexError, TypeError):
        raise ParseError("模型响应缺少 choices[0].message.content")


def _json_of(text: str) -> dict:
    cleaned = re.sub(r"^```(?:json)?|```$", "", text.strip(), flags=re.M).strip()
    start, end = cleaned.find("{"), cleaned.rfind("}")
    if start < 0 or end <= start:
        raise ParseError("模型没有返回 JSON")
    try:
        value = json.loads(cleaned[start:end + 1])
    except json.JSONDecodeError:
        raise ParseError("模型返回的 JSON 无法解析")
    if not isinstance(value, dict):
        raise ParseError("模型返回的 JSON 不是对象")
    return value


def _text(value) -> str:
    return "" if value is None else str(value).strip()


def _deadline(value) -> str:
    """把截止时间规范成 YYYY-MM-DD 或 YYYY-MM-DD HH:MM，认不出就返回空。"""
    match = re.search(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(?:[ T](\d{1,2}):(\d{2}))?", _text(value))
    if not match:
        return ""
    year, month, day, hour, minute = match.groups()
    stamp = f"{int(year):04d}-{int(month):02d}-{int(day):02d}"
    fmt = "%Y-%m-%d"
    if hour is not None:
        stamp += f" {int(hour):02d}:{minute}"
        fmt = "%Y-%m-%d %H:%M"
    try:
        datetime.strptime(stamp, fmt)
    except ValueError:
        return ""
    return stamp


def _received(value: str):
    try:
        return datetime.strptime(_text(value)[:19], "%Y-%m-%d %H:%M:%S")
    except ValueError:
        return None


def _event(raw, received_at: str = "") -> dict | None:
    """校验单条事件；缺公司或既无开始日期又无截止时间就丢弃。"""
    if not isinstance(raw, dict):
        return None
    draft = {
        "type": "other",
        "company": _text(raw.get("company")),
        "position": _text(raw.get("position")),
        "round": _text(raw.get("round")) or _text(raw.get("activity")),
        "start_date": _text(raw.get("start_date")),
        "start_time": _text(raw.get("start_time"))[:5],
        "end_date": _text(raw.get("end_date")),
        "end_time": _text(raw.get("end_time"))[:5],
        "mode": _text(raw.get("mode"))[:20],
        "location": _text(raw.get("location"))[:120],
        "link": _text(raw.get("link")),
        "deadline": "",
        "note": _text(raw.get("note")) or "无特殊要求",
        "source": "mail",
    }
    if not draft["company"]:
        return None

    deadline = _deadline(raw.get("deadline"))
    if not deadline:
        # 「收到邮件后 N 小时内」这类相对要求，用收件时间换算成绝对时间
        try:
            hours = int(float(raw.get("deadline_hours")))
        except (TypeError, ValueError):
            hours = 0
        base = _received(received_at)
        if 0 < hours <= 24 * 90 and base:
            # 按整点向前取整：14:35 + 72h 记作 14:00，宁可早一点
            end = base + timedelta(hours=hours)
            end = end.replace(minute=0, second=0, microsecond=0)
            deadline = end.strftime("%Y-%m-%d %H:%M")
    draft["deadline"] = deadline

    if not draft["start_date"]:
        if not deadline:
            return None
        draft["start_date"], _, draft["start_time"] = deadline.partition(" ")
        draft["extra"] = {"kind": "deadline"}
    if not draft["end_time"]:
        draft["end_date"] = ""
    try:
        return events.normalize(draft, {"source": "mail", "status": "normal"})
    except ValueError:
        return None


def parse_mail(mail: dict) -> dict:
    """返回 {"summary", "events", "dropped"}。"""
    ai = config.load().get("ai") or {}
    base_url = _text(ai.get("base_url"))
    api_key = _text(ai.get("api_key"))
    model = _text(ai.get("model"))
    if not base_url or not api_key or not model:
        raise ParseError("还没配置模型接口、模型名或 API Key")

    received = _text(mail.get("received_at")) or ""
    body = mail.get("body") or ""
    user = (
        f"邮件收件时间：{received}\n"
        f"发件人：{_text(mail.get('from_addr'))}\n"
        f"主题：{_text(mail.get('subject'))}\n"
        f"正文：\n{body}"
    )
    payload = {
        "model": model,
        "temperature": 0,
        "messages": [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": user},
        ],
        "response_format": {"type": "json_object"},
    }
    url = _endpoint(base_url)
    try:
        data = _request(url, api_key, payload)
    except ParseError as exc:
        # 部分兼容接口不认 response_format，去掉再试一次
        if "400" not in str(exc):
            raise
        payload.pop("response_format", None)
        data = _request(url, api_key, payload)

    result = _json_of(_content(data))
    raw_events = result.get("events")
    raw_events = raw_events if isinstance(raw_events, list) else []
    drafts, dropped = [], 0
    for raw in raw_events[:MAX_EVENTS]:
        item = _event(raw, received)
        if item:
            drafts.append(item)
        else:
            dropped += 1
    return {
        "summary": _text(result.get("summary"))[:300],
        "events": drafts,
        "dropped": dropped,
    }