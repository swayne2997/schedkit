# SchedKit

从招聘邮件里自动提取面试、笔试、测评安排，生成日程并在到点前提醒的 Windows 桌面小工具。

## 功能

- 通过 IMAP 拉取邮箱邮件（默认 163 邮箱）
- 调用兼容 OpenAI 接口的模型，从邮件正文中识别需要本人参加的事项
- 识别结果先进入「待确认」队列，确认后才写入日程，避免误判直接污染日历
- 周视图 / 日视图、农历与传统色、托盘常驻、开机自启
- 可配置多条提醒规则（提前 N 天 / 提前 N 分钟）

## 运行

需要 Windows + Python 3.11。

```bash
pip install -r requirements.txt
copy config.example.json config.json
python main.py
```

首次运行后打开界面右下角的设置，依次填写：

| 字段 | 说明 |
|---|---|
| 邮箱账号 / IMAP 授权码 | 163 邮箱需在网页版设置中开启 IMAP 并生成授权码 |
| 模型接口地址 / API Key / 模型名 | 任何兼容 OpenAI Chat Completions 的服务 |

也可以在启动前直接编辑 `config.json` 填入上述内容。

## 数据与隐私

- `config.json` 保存邮箱授权码和模型 API Key，仅存于本地，已被 `.gitignore` 排除。
- 邮件正文与解析结果保存在本地 SQLite（`data/scheduler.db`），不上传任何服务器。
- **邮件正文会整封发送给你配置的模型服务**用于解析，请自行评估该服务的数据政策。
- 仓库内不含任何个人邮件、凭证或浏览器缓存。

## 目录结构

```
main.py            程序入口：本地服务 + 窗口 + 托盘 + 提醒轮询
core/              配置、数据库、IMAP、解析、提醒、同步
server/api.py      本地 HTTP 接口与静态资源（仅监听 127.0.0.1）
ui/                前端界面（原生 JS，无构建步骤）
assets/            图标
data/cncolor.json  传统色与节气数据
```

## 平台说明

依赖 Windows 的注册表与托盘能力，目前仅在 Windows 上运行。