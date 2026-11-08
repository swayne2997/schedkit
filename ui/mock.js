/*
 * 离线预览用的演示数据（直接双击 index.html 或静态服务器打开时生效）。
 * 字段与数据库一致，日期相对今天生成。
 */
(function () {
  function pad(n) {
    return String(n).length < 2 ? '0' + n : String(n);
  }

  function at(offsetDay, hh, mm) {
    var d = new Date();
    d.setHours(0, 0, 0, 0);
    d.setDate(d.getDate() + offsetDay);
    return {
      date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()),
      time: pad(hh) + ':' + pad(mm)
    };
  }

  function ev(id, offset, hh, mm, type, company, position, round, mode, extra) {
    var s = at(offset, hh, mm);
    var e = at(offset, hh + 1, mm);
    return Object.assign({
      id: id,
      type: type,
      company: company,
      position: position,
      round: round,
      start_date: s.date,
      start_time: s.time,
      end_date: e.date,
      end_time: e.time,
      mode: mode,
      link: '',
      deadline: '',
      status: 'normal',
      source: 'mail',
      note: ''
    }, extra || {});
  }

  var events = [
    ev('e01', -2, 10, 0, 'written', '美团', '后端开发', '笔试', '线上',
      { note: '牛客网，90 分钟，需开摄像头。' }),
    ev('e02', -1, 15, 30, 'interview', '小红书', '服务端开发', '一面', '线上',
      { link: 'https://example.com/meeting/xhs-1' }),
    ev('e03', 0, 11, 0, 'interview', '字节跳动', '后端开发', '二面', '线上',
      { link: 'https://example.com/meeting/bytedance-2' }),
    ev('e05', 1, 9, 30, 'assessment', '华为', '软件开发', '机试', '线上',
      { note: '三道编程题，150 分钟。' }),
    ev('e06', 1, 14, 0, 'interview', '腾讯', '后台开发', '一面', '线上',
      { link: 'https://example.com/meeting/tencent-1' }),
    ev('e07', 2, 10, 0, 'interview', '阿里巴巴', 'Java 开发', '三面', '线下',
      { note: '杭州西溪园区，带身份证。' }),
    ev('e08', 2, 19, 0, 'written', '京东', '后端开发', '笔试', '线上'),
    ev('e09', 3, 13, 30, 'interview', '米哈游', '服务端开发', 'HR 面', '线上'),
    ev('e11', 4, 10, 30, 'interview', '网易', '游戏研发', '二面', '线上'),
    ev('e12', 4, 15, 0, 'other', '学校就业中心', '秋招材料', '提交三方协议', '线下'),
    ev('e13', 6, 14, 0, 'interview', '字节跳动', '后端开发', 'HR 面', '线上'),
    ev('e14', 6, 11, 0, 'written', '拼多多', '服务端开发', '笔试', '线上'),
    ev('e15', 9, 14, 0, 'interview', '美团', '后端开发', '一面', '线上',
      { status: 'cancelled', note: '对方调整为下周，等待新邮件。' }),
    ev('e16', 12, 10, 0, 'interview', '腾讯', '后台开发', '二面', '线上')
  ];

  window.MOCK = { events: events, pending: 2 };
})();