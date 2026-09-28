/* ===========================================================================
   Nezha monitoring theme — Windows 2000
   ---------------------------------------------------------------------------
   A user-facing frontend for nezha (nezhahq/nezha) that reads the same public
   endpoints the official frontend does and draws them as one Windows 2000
   application window.

     GET  /api/v1/setting                site name, language, custom code
     WS   /api/v1/ws/server              the fleet, pushed every ~2s
     GET  /api/v1/service-groups         server groups
     GET  /api/v1/service                per-service uptime, 30 days
     GET  /api/v1/service/server         which servers have probes
     GET  /api/v1/server/:id/service     one server's probes + delay series
     GET  /api/v1/server/:id/metrics     TSDB charts (members get >1d)
     GET  /api/v1/profile                whether this browser is signed in

   No build step and no dependencies: the panel serves this directory as static
   files, so anything needing a compiler would need a toolchain on the server.
   Frames arrive every two seconds, so values are patched into nodes that are
   already built rather than re-rendered -- a re-render would close open menus
   and make the meters flicker.
   ======================================================================== */

(function () {
  "use strict";

  var API = "/api/v1";
  var SKIN_KEY = "nezha:w2k-skin";
  var SCHEME_KEY = "nezha:w2k-scheme";
  var VIEW_KEY = "nezha:w2k-view";
  var NOTE_KEY = "nezha:w2k-notes";
  var OFFLINE_AFTER_MS = 30000; // nezha's own staleness rule for a server
  var PROBE_TTL_MS = 90000;
  var PROBE_MAX_SERVERS = 60;
  var SERVICE_REFRESH_MS = 60000;
  var HOT_AT = 90; // above this the meter switches to the alarm colour
  var DAY_MS = 86400000;
  var KIB = 1024;

  /* --- tiny DOM helpers ------------------------------------------------- */

  function append(parent, kids) {
    if (kids == null || kids === false) return parent;
    (Array.isArray(kids) ? kids : [kids]).forEach(function (kid) {
      if (kid == null || kid === false) return;
      parent.appendChild(
        typeof kid === "object" && kid.nodeType
          ? kid
          : document.createTextNode(String(kid))
      );
    });
    return parent;
  }

  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        var v = attrs[k];
        if (v == null || v === false) return;
        if (k === "class") e.className = v;
        else if (k === "text") e.textContent = v;
        else if (k === "html") e.innerHTML = v;
        else if (k === "style") e.style.cssText = v;
        else if (k === "dataset") {
          Object.keys(v).forEach(function (d) {
            e.dataset[d] = v[d];
          });
        } else if (k.slice(0, 2) === "on" && typeof v === "function") {
          e.addEventListener(k.slice(2), v);
        } else e.setAttribute(k, v === true ? "" : v);
      });
    }
    return append(e, kids);
  }

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
    return node;
  }

  function svgMarkup(markup, cls) {
    var wrap = h("span", { class: cls, "aria-hidden": "true" });
    wrap.innerHTML = markup;
    return wrap;
  }

  function monitorIcon(cls) {
    return svgMarkup(
      '<svg viewBox="0 0 16 16" width="16" height="16">' +
        '<rect x="0" y="1" width="16" height="11" fill="#d4d0c8" stroke="#404040"/>' +
        '<rect x="1" y="2" width="14" height="9" fill="#0a246a"/>' +
        '<rect x="2" y="3" width="12" height="2" fill="#3a8ee6"/>' +
        '<rect x="3" y="6" width="6" height="1" fill="#a6caf0"/>' +
        '<rect x="3" y="8" width="9" height="1" fill="#a6caf0"/>' +
        '<rect x="6" y="12" width="4" height="2" fill="#d4d0c8" stroke="#404040"/>' +
        '<rect x="3" y="14" width="10" height="2" fill="#d4d0c8" stroke="#404040"/>' +
        "</svg>",
      cls
    );
  }

  /* --- toolbar glyphs: 16x16 pixel-art style, the Win32 toolbar way.
     Cards/table/skin/back are fixed colours; ring borrows the theme's pie
     colours; the scheme glyphs follow currentColor. ---------------------- */
  var ICONS = {
    cards:
      '<rect x="1.5" y="1.5" width="6" height="6" fill="#fff" stroke="#0a246a"/>' +
      '<rect x="8.5" y="1.5" width="6" height="6" fill="#fff" stroke="#0a246a"/>' +
      '<rect x="1.5" y="8.5" width="6" height="6" fill="#fff" stroke="#0a246a"/>' +
      '<rect x="8.5" y="8.5" width="6" height="6" fill="#fff" stroke="#0a246a"/>' +
      '<rect x="3" y="3" width="3" height="1" fill="#0a246a"/><rect x="10" y="3" width="3" height="1" fill="#0a246a"/>' +
      '<rect x="3" y="10" width="3" height="1" fill="#0a246a"/><rect x="10" y="10" width="3" height="1" fill="#0a246a"/>',
    ring:
      '<circle cx="8" cy="8" r="6.5" fill="var(--pie-free)" stroke="#000"/>' +
      '<path d="M8 8V1.5A6.5 6.5 0 0 1 14.2 10z" fill="var(--pie-used)"/>',
    table:
      '<rect x="1.5" y="2.5" width="13" height="11" fill="#fff" stroke="#000"/>' +
      '<rect x="2" y="3" width="12" height="2" fill="#d4d0c8"/>' +
      '<path d="M3 7.5h10M3 9.5h10M3 11.5h10" stroke="#0a246a"/>',
    back:
      '<circle cx="8" cy="8" r="7" fill="#3cb043" stroke="#1e6b22"/>' +
      '<path d="M9.5 4l-4 4 4 4" stroke="#fff" stroke-width="2.2" fill="none"/>',
    skin:
      '<rect x="1.5" y="1.5" width="6" height="6" fill="#0000a8" stroke="#404040"/>' +
      '<rect x="8.5" y="1.5" width="6" height="6" fill="#3f8cf3" stroke="#404040"/>' +
      '<rect x="1.5" y="8.5" width="6" height="6" fill="#008080" stroke="#404040"/>' +
      '<rect x="8.5" y="8.5" width="6" height="6" fill="#d8d8d8" stroke="#404040"/>',
    sun:
      '<g transform="translate(3.5 3.5)" stroke="currentColor" stroke-width="1.2" fill="none">' +
      '<circle cx="4.5" cy="4.5" r="2"/><path d="M4.5 0v1.3M4.5 7.7V9M0 4.5h1.3M7.7 4.5H9"/></g>',
    moon:
      '<g transform="translate(3.5 3.5)"><path d="M6.5 0.8A4 4 0 1 0 8.2 6.5 3.2 3.2 0 0 1 6.5 0.8z" fill="currentColor"/></g>',
    gear:
      '<g transform="translate(3.5 3.5)" stroke="currentColor" stroke-width="1.4" fill="none">' +
      '<circle cx="4.5" cy="4.5" r="2.2"/><path d="M4.5 0v2M4.5 7v2M0 4.5h2M7 4.5h2"/></g>',
  };

  function icon(name, size) {
    var px = size || 16;
    return h("span", {
      class: "tb-icon",
      style: "width:" + px + "px;height:" + px + "px",
      "aria-hidden": "true",
      html:
        '<svg viewBox="0 0 16 16" width="' + px + '" height="' + px + '">' +
        (ICONS[name] || "") +
        "</svg>",
    });
  }

  /* --- i18n ------------------------------------------------------------- */

  var STRINGS = {
    zh: {
      title: "服务器监控",
      connecting: "正在连接监控面板…",
      connected: "已连接",
      reconnecting: "连接已断开，正在重连…",
      servers: "服务器",
      online: "在线",
      offline: "离线",
      noServers: "没有可显示的服务器",
      noMatch: "没有匹配的服务器",
      fleet: "服务器",
      speed: "实时速度",
      traffic: "累计流量",
      busiest: "最忙节点",
      viewCard: "卡片",
      viewRing: "圆环",
      viewTable: "表格",
      find: "查找",
      findPlaceholder: "名称 / 系统 / 架构",
      sortBy: "排序",
      sortDefault: "默认排序",
      sortCpu: "CPU 占用",
      sortMem: "内存占用",
      sortDisk: "硬盘占用",
      sortSpeed: "实时速度",
      sortName: "名称",
      all: "全部",
      more: "更多",
      units: "台服务器",
      skin: "皮肤",
      scheme: "配色",
      schemeAuto: "跟随系统",
      schemeLight: "浅色",
      schemeDark: "深色",
      about: "关于",
      adminPanel: "管理后台",
      close: "关闭",
      back: "返回",
      cpu: "CPU",
      memory: "内存",
      disk: "硬盘",
      swap: "交换",
      usage: "用量",
      load: "负载",
      uptimePrefix: "在线",
      offlinePrefix: "离线",
      forDays: "天",
      forHours: "小时",
      forMinutes: "分钟",
      forSeconds: "秒",
      remaining: "剩余",
      price: "价格",
      free: "免费",
      usageBased: "按量计费",
      forever: "永不过期",
      expired: "已过期",
      perMonth: "月付",
      perYear: "年付",
      perQuarter: "季付",
      perHalf: "半年付",
      perTwoYears: "两年付",
      perThreeYears: "三年付",
      oneTime: "一次性",
      neverSeen: "未接入",
      timeout: "超时",
      renew: "续费",
      monitorPage: "监控页面",
      backList: "返回列表",
      samples: "{n} 个采样点",
      regionEmpty: "这个地区没有服务器",
      cycleTraffic: "本周期流量",
      totalTraffic: "累计流量",
      bucketRtt: "最近 1 天每个采样桶的往返时延",
      bucketLoss: "30 天内每天的丢包比例",
      probes: "服务监控",
      loss: "丢包",
      noData: "暂无数据",
      host: "主机信息",
      fPlatform: "系统",
      fPlatformVersion: "系统版本",
      fArch: "架构",
      fVirtualization: "虚拟化",
      fCpu: "处理器",
      fMem: "内存",
      fSwap: "交换分区",
      fDisk: "硬盘",
      fGpu: "显卡",
      fBootTime: "启动时间",
      fUptime: "运行时长",
      fLastActive: "最后上报",
      fAgentVersion: "探针版本",
      fRegion: "地区",
      fGroup: "分组",
      temperature: "温度",
      charts: "性能图表",
      chartCpu: "CPU 使用率",
      chartMem: "内存使用",
      chartNet: "网络速度",
      chartLoad: "负载",
      chartLatency: "网络延迟",
      chartLatencySub: "时间范围内每个探测的往返时延",
      netIn: "下行",
      netOut: "上行",
      avg: "平均",
      max: "最大",
      current: "当前",
      tsdbOff: "面板未启用 TSDB，无法查询历史数据",
      chartEmpty: "这个时间段没有数据",
      period: "时间范围",
      period1d: "最近 1 天",
      period7d: "最近 7 天",
      period30d: "最近 30 天",
      short1d: "1 天",
      short7d: "7 天",
      short30d: "30 天",
      membersOnly: "登录后可查看更长时间范围",
      uptimeRate: "可用率",
      showMore: "还有 {n} 项",
      aboutTitle: "关于这个主题",
      aboutTheme:
        "仿 Windows 2000 的哪吒面板前台主题：灰色立体控件、蓝色渐变的标题栏、分段进度条与宋体小字，整页是桌面上的一扇窗口。",
      aboutSkin:
        "右上角可以切换皮肤（Windows 3.1 / Windows 2000 / Windows XP / Mac OS X）与深浅配色，选择记在这台浏览器里。",
      aboutData: "数据来自面板的公开接口，未登录只能看到最近 1 天的历史数据。",
      poweredBy: "Powered by Nezha",
      visitor: "在线访客",
      updated: "已更新",
      errorTitle: "出错了",
      wsError: "无法连接面板的数据接口，请确认面板正在运行并允许 WebSocket。",
      settingError: "读取面板配置失败，已使用默认设置。",
      cancel: "关闭",
      skin31: "Windows 3.1",
      skin2000: "Windows 2000",
      skinXp: "Windows XP",
      skinAqua: "Mac OS X 10.6",
      order: "购买链接",
      bandwidth: "带宽",
      planTraffic: "流量",
      route: "线路",
      ipv4v6: "IP",
    },
    en: {
      title: "Server Monitor",
      connecting: "Connecting to the dashboard…",
      connected: "Connected",
      reconnecting: "Disconnected, reconnecting…",
      servers: "Servers",
      online: "online",
      offline: "offline",
      noServers: "No servers to show",
      noMatch: "No server matches the filter",
      fleet: "Servers",
      speed: "Live speed",
      traffic: "Total traffic",
      busiest: "Busiest",
      viewCard: "Cards",
      viewRing: "Rings",
      viewTable: "Table",
      find: "Find",
      findPlaceholder: "name / os / arch",
      sortBy: "Sort",
      sortDefault: "Default order",
      sortCpu: "CPU usage",
      sortMem: "Memory usage",
      sortDisk: "Disk usage",
      sortSpeed: "Live speed",
      sortName: "Name",
      all: "All",
      more: "More",
      units: "servers",
      skin: "Skin",
      scheme: "Colours",
      schemeAuto: "System",
      schemeLight: "Light",
      schemeDark: "Dark",
      about: "About",
      adminPanel: "Admin console",
      close: "Close",
      back: "Back",
      cpu: "CPU",
      memory: "Memory",
      disk: "Disk",
      swap: "Swap",
      usage: "Quota",
      load: "Load",
      uptimePrefix: "Up",
      offlinePrefix: "Down",
      forDays: "d",
      forHours: "h",
      forMinutes: "m",
      forSeconds: "s",
      remaining: "Left",
      price: "Price",
      free: "free",
      usageBased: "pay as you go",
      forever: "never expires",
      expired: "expired",
      perMonth: "/mo",
      perYear: "/yr",
      perQuarter: "/qtr",
      perHalf: "/half",
      perTwoYears: "/2 yr",
      perThreeYears: "/3 yr",
      oneTime: "one-time",
      neverSeen: "never seen",
      timeout: "timeout",
      renew: "renew",
      monitorPage: "Monitor",
      backList: "Back",
      samples: "{n} samples",
      regionEmpty: "No servers in this region",
      cycleTraffic: "This cycle",
      totalTraffic: "Total",
      bucketRtt: "Round-trip delay per sample bucket (last day)",
      bucketLoss: "Daily loss ratio over 30 days",
      probes: "Service checks",
      loss: "loss",
      noData: "no data",
      host: "Host",
      fPlatform: "OS",
      fPlatformVersion: "OS version",
      fArch: "Arch",
      fVirtualization: "Virtualization",
      fCpu: "Processor",
      fMem: "Memory",
      fSwap: "Swap",
      fDisk: "Disk",
      fGpu: "GPU",
      fBootTime: "Boot time",
      fUptime: "Uptime",
      fLastActive: "Last report",
      fAgentVersion: "Agent",
      fRegion: "Region",
      fGroup: "Group",
      temperature: "Sensors",
      charts: "Charts",
      chartCpu: "CPU usage",
      chartMem: "Memory used",
      chartNet: "Network",
      chartLoad: "Load average",
      chartLatency: "Latency",
      chartLatencySub: "Round-trip delay of each probe over the range",
      netIn: "in",
      netOut: "out",
      avg: "avg",
      max: "max",
      current: "now",
      tsdbOff: "TSDB is not enabled on this dashboard, no history available",
      chartEmpty: "No data in this period",
      period: "Range",
      period1d: "Last 1 day",
      period7d: "Last 7 days",
      period30d: "Last 30 days",
      short1d: "1d",
      short7d: "7d",
      short30d: "30d",
      membersOnly: "Sign in for longer ranges",
      uptimeRate: "Uptime",
      showMore: "{n} more",
      aboutTitle: "About this theme",
      aboutTheme:
        "A Windows 2000 front end for the nezha dashboard: grey bevelled controls, a blue gradient title bar, segmented meters and small Song type, with the whole page as one window on a desktop.",
      aboutSkin:
        "The title bar switches skin (Windows 3.1 / Windows 2000 / Windows XP / Mac OS X) and colour scheme; both are remembered in this browser.",
      aboutData:
        "Data comes from the dashboard's public API. Signed-out visitors only see the last day of history.",
      poweredBy: "Powered by Nezha",
      visitor: "visitors",
      updated: "updated",
      errorTitle: "Something went wrong",
      wsError:
        "Could not reach the dashboard's data endpoint. Check the dashboard is running and that WebSocket is allowed.",
      settingError: "Could not read the dashboard settings, using defaults.",
      cancel: "Close",
      skin31: "Windows 3.1",
      skin2000: "Windows 2000",
      skinXp: "Windows XP",
      skinAqua: "Mac OS X 10.6",
      order: "Order",
      bandwidth: "Bandwidth",
      planTraffic: "Traffic",
      route: "Route",
      ipv4v6: "IP",
    },
  };

  var lang = "zh";

  function t(key, vars) {
    var dict = STRINGS[lang] || STRINGS.zh;
    var s = dict[key] != null ? dict[key] : STRINGS.zh[key] || key;
    if (vars) {
      Object.keys(vars).forEach(function (k) {
        s = s.replace("{" + k + "}", vars[k]);
      });
    }
    return s;
  }

  /* --- formatters ------------------------------------------------------- */

  function decimalsFor(n) {
    var a = Math.abs(n);
    if (a >= 100) return 0;
    return a >= 10 ? 1 : 2;
  }

  // The figure and its unit come back apart so the unit can be set smaller and
  // muted, the way the OS drew labels next to a value.
  function bytes(n) {
    n = Number(n) || 0;
    var units = ["B", "KB", "MB", "GB", "TB", "PB"];
    var i = 0;
    while (n >= KIB && i < units.length - 1) {
      n /= KIB;
      i++;
    }
    return { v: n.toFixed(i === 0 ? 0 : decimalsFor(n)), u: units[i] };
  }

  function byteText(n) {
    var b = bytes(n);
    return b.v + " " + b.u;
  }

  function speedText(n) {
    var b = bytes(n);
    return b.v + " " + b.u + "/s";
  }

  function percentText(p, digits) {
    if (!isFinite(p)) return "—";
    return p.toFixed(digits == null ? 2 : digits) + "%";
  }

  function ratio(part, whole) {
    if (!whole) return 0;
    return (Number(part) / Number(whole)) * 100;
  }

  function clampPct(p) {
    if (!isFinite(p) || p < 0) return 0;
    return p > 100 ? 100 : p;
  }

  function durationShort(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    if (seconds >= 86400) return Math.floor(seconds / 86400) + " " + t("forDays");
    if (seconds >= 3600) return Math.floor(seconds / 3600) + " " + t("forHours");
    if (seconds >= 60) return Math.floor(seconds / 60) + " " + t("forMinutes");
    return seconds + " " + t("forSeconds");
  }

  function durationLong(seconds) {
    seconds = Math.max(0, Math.floor(Number(seconds) || 0));
    var d = Math.floor(seconds / 86400);
    var rest = seconds % 86400;
    var hr = Math.floor(rest / 3600);
    rest %= 3600;
    var mi = Math.floor(rest / 60);
    var out = [];
    if (d) out.push(d + " " + t("forDays"));
    if (hr) out.push(hr + " " + t("forHours"));
    if (mi) out.push(mi + " " + t("forMinutes"));
    if (!out.length) out.push(seconds % 60 + " " + t("forSeconds"));
    return out.join(" ");
  }

  function pad2(v) {
    return v < 10 ? "0" + v : String(v);
  }

  function dateTimeText(ms) {
    if (!ms) return "—";
    var d = new Date(ms);
    return (
      d.getFullYear() +
      "-" +
      pad2(d.getMonth() + 1) +
      "-" +
      pad2(d.getDate()) +
      " " +
      pad2(d.getHours()) +
      ":" +
      pad2(d.getMinutes()) +
      ":" +
      pad2(d.getSeconds())
    );
  }

  function timeText(ms) {
    var d = new Date(ms);
    return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
  }

  // Go writes time.Time as RFC3339 with nanoseconds and the zero time as
  // "0001-01-01T00:00:00Z"; both need guarding before Date can be trusted.
  function parseTime(value) {
    if (!value || typeof value !== "string" || value.slice(0, 3) === "000") return 0;
    var ms = Date.parse(value);
    return isNaN(ms) ? 0 : ms;
  }

  function safeUrl(value) {
    if (typeof value !== "string") return "";
    var s = value.trim();
    // Anything but http(s) is dropped: a public note is data an administrator
    // typed, and `javascript:` in an href is an XSS deliverable.
    return /^https?:\/\//i.test(s) ? s : "";
  }

  // Country names for the filter row, mirroring the original theme's Chinese
  // labels.  Codes without an entry fall back to the upper-case code itself.
  var COUNTRY_NAMES = {
    ad:"安道尔",ae:"阿联酋",al:"阿尔巴尼亚",am:"亚美尼亚",ar:"阿根廷",at:"奥地利",au:"澳大利亚",az:"阿塞拜疆",
    ba:"波黑",bd:"孟加拉",be:"比利时",bg:"保加利亚",br:"巴西",by:"白俄罗斯",ca:"加拿大",ch:"瑞士",cl:"智利",
    cn:"中国",co:"哥伦比亚",cr:"哥斯达黎加",cu:"古巴",cy:"塞浦路斯",cz:"捷克",de:"德国",dk:"丹麦",do:"多米尼加",
    dz:"阿尔及利亚",ec:"厄瓜多尔",ee:"爱沙尼亚",eg:"埃及",es:"西班牙",eu:"欧盟",fi:"芬兰",fr:"法国",gb:"英国",
    ge:"格鲁吉亚",gh:"加纳",gr:"希腊",hk:"香港",hr:"克罗地亚",hu:"匈牙利",id:"印尼",ie:"爱尔兰",il:"以色列",
    in:"印度",iq:"伊拉克",ir:"伊朗",is:"冰岛",it:"意大利",jo:"约旦",jp:"日本",ke:"肯尼亚",kg:"吉尔吉斯斯坦",
    kh:"柬埔寨",kr:"韩国",kw:"科威特",kz:"哈萨克斯坦",la:"老挝",lk:"斯里兰卡",lt:"立陶宛",lu:"卢森堡",lv:"拉脱维亚",
    ma:"摩洛哥",md:"摩尔多瓦",me:"黑山",mk:"北马其顿",mm:"缅甸",mn:"蒙古",mo:"澳门",mt:"马耳他",mx:"墨西哥",
    my:"马来西亚",mz:"莫桑比克",ng:"尼日利亚",nl:"荷兰",no:"挪威",np:"尼泊尔",nz:"新西兰",pe:"秘鲁",ph:"菲律宾",
    pk:"巴基斯坦",pl:"波兰",pt:"葡萄牙",py:"巴拉圭",qa:"卡塔尔",ro:"罗马尼亚",rs:"塞尔维亚",ru:"俄罗斯",sa:"沙特",
    se:"瑞典",sg:"新加坡",si:"斯洛文尼亚",sk:"斯洛伐克",th:"泰国",tn:"突尼斯",tr:"土耳其",tw:"台湾",ua:"乌克兰",
    ug:"乌干达",us:"美国",uy:"乌拉圭",uz:"乌兹别克斯坦",va:"梵蒂冈",ve:"委内瑞拉",vn:"越南",za:"南非",
  };

  function countryName(code) {
    var cc = String(code || "").trim().toLowerCase();
    return COUNTRY_NAMES[cc] || cc.toUpperCase();
  }

  // host.platform -> simple-icons slug, mirroring tools/fetch-os-icons.py.
  // Anything unknown falls back to the bundled generic mark, and if even that
  // is missing the icon removes itself rather than showing a broken image.
  var OS_SLUGS = {
    ubuntu: "ubuntu", debian: "debian", centos: "centos", alpine: "alpinelinux",
    arch: "archlinux", archlinux: "archlinux", manjaro: "manjaro", fedora: "fedora",
    redhat: "redhat", rhel: "redhat", rocky: "rockylinux", rockylinux: "rockylinux",
    almalinux: "almalinux", opensuse: "opensuse", suse: "opensuse",
    linuxmint: "linuxmint", mint: "linuxmint", kali: "kalilinux", gentoo: "gentoo",
    nixos: "nixos", void: "voidlinux", freebsd: "freebsd", openwrt: "openwrt",
    raspbian: "raspberrypi", raspberrypi: "raspberrypi", oracle: "oracle",
    ol: "oracle", windows: "windows", darwin: "apple", macos: "apple", osx: "apple",
    apple: "apple", deepin: "linux",
  };

  function osSlug(platform) {
    var key = String(platform || "").trim().toLowerCase();
    var slug = OS_SLUGS[key];
    if (slug) return slug;
    // Report strings vary; a couple of loose matches catch most of them.
    if (/win/.test(key)) return "windows";
    if (/darwin|mac/.test(key)) return "apple";
    if (/alp/.test(key)) return "alpinelinux";
    if (/deb/.test(key)) return "debian";
    if (/ubu/.test(key)) return "ubuntu";
    if (/cent/.test(key)) return "centos";
    if (/arch/.test(key)) return "archlinux";
    if (/rocky/.test(key)) return "rockylinux";
    if (/alma/.test(key)) return "almalinux";
    if (/suse/.test(key)) return "opensuse";
    if (/rasp/.test(key)) return "raspberrypi";
    return /linux|gnu|bsd|unix/.test(key) ? "linux" : "generic";
  }

  function osIcon(platform) {
    return h("img", {
      class: "os-icon-img",
      src: "/assets/os/" + osSlug(platform) + ".svg",
      alt: "",
      "aria-hidden": "true",
      loading: "lazy",
      onerror: function () {
        if (this.dataset.fb) {
          if (this.parentNode) this.parentNode.removeChild(this);
          return;
        }
        this.dataset.fb = "1";
        this.src = "/assets/os/generic.svg";
      },
    });
  }

  function flagNode(code) {
    var cc = String(code || "").trim().toLowerCase();
    if (!/^[a-z]{2}$/.test(cc)) {
      return h("span", { class: "flag-fallback", text: cc ? cc.slice(0, 2) : "??" });
    }
    // Decorative: every place a flag appears it sits next to the country code
    // or the server name, and an `alt` of "jp" only makes screen readers spell
    // out noise ahead of the real label.
    return h("img", {
      class: "flag-img",
      src: "/assets/flags/" + cc + ".svg",
      alt: "",
      "aria-hidden": "true",
      loading: "lazy",
      onerror: function () {
        // A country the flag set does not carry still gets a placeholder
        // rather than a broken image.
        var fb = h("span", { class: "flag-fallback", text: cc, "aria-hidden": "true" });
        if (this.parentNode) this.parentNode.replaceChild(fb, this);
      },
    });
  }

  /* --- public note: billing and plan metadata --------------------------- */

  function parsePublicNote(raw) {
    if (!raw) return null;
    var data;
    try {
      data = JSON.parse(raw);
    } catch (e) {
      // Plain text is a valid public note too; the caller shows it as one.
      return { text: raw };
    }
    if (!data || typeof data !== "object") return { text: String(raw) };

    var b = data.billingDataMod || null;
    var p = data.planDataMod || null;
    var out = {
      billing: b
        ? {
            startDate: b.startDate || "",
            endDate: b.endDate || "",
            autoRenewal: b.autoRenewal || "",
            cycle: b.cycle || "",
            amount: b.amount == null ? "" : String(b.amount),
          }
        : null,
      plan: p
        ? {
            bandwidth: p.bandwidth || "",
            trafficVol: p.trafficVol || "",
            route: p.networkRoute || "",
            ipv4: p.IPv4 || "",
            ipv6: p.IPv6 || "",
          }
        : null,
      orderLink: safeUrl(data.orderLink || data.order_link),
      text: "",
    };
    if (!out.billing && !out.plan && !out.orderLink) {
      out.text = typeof data.text === "string" ? data.text : raw;
    }
    return out;
  }

  function cycleInfo(cycle) {
    var c = String(cycle || "").trim().toLowerCase();
    if (!c || c === "一次性" || c === "once" || c === "one-time" || c === "onetime")
      return { months: 0, key: "oneTime" };
    if (c === "季" || c === "q" || c === "qr" || c === "quarter" || c === "quarterly")
      return { months: 3, key: "perQuarter" };
    if (c === "半" || c === "半年" || c === "h" || c === "half" || c.indexOf("semi") === 0)
      return { months: 6, key: "perHalf" };
    if (c === "两年" || c === "2年" || c === "两年付" || c === "biennial" || c === "2y" || c === "2yr" || c === "two year")
      return { months: 24, key: "perTwoYears" };
    if (c === "三年" || c === "3年" || c === "三年付" || c === "triennial" || c === "3y" || c === "3yr" || c === "three year")
      return { months: 36, key: "perThreeYears" };
    if (c === "年" || c === "y" || c === "yr" || c === "year" || c === "annual" || c === "yearly")
      return { months: 12, key: "perYear" };
    return { months: 1, key: "perMonth" };
  }

  function addMonths(ms, months) {
    var d = new Date(ms);
    var day = d.getDate();
    d.setMonth(d.getMonth() + months);
    // 1月31日 plus one month would otherwise spill into March.
    if (d.getDate() < day) d.setDate(0);
    return d.getTime();
  }

  // Days left in the paid cycle, plus how much of it remains.  The conventions
  // are the official frontend's: "0000-00-00" never expires, and a past end
  // date with autoRenewal rolls forward one cycle at a time.
  function billingLeft(billing) {
    if (!billing || !billing.endDate) return null;
    if (billing.endDate.slice(0, 10) === "0000-00-00") return { forever: true };
    var end = Date.parse(billing.endDate);
    if (isNaN(end)) return null;
    var now = Date.now();
    var info = cycleInfo(billing.cycle);
    var months = info.months;
    var start = billing.startDate ? Date.parse(billing.startDate) : 0;

    if (end > now) {
      var span = start && start < end ? end - start : 30 * months * DAY_MS;
      return {
        days: Math.round((end - now) / DAY_MS),
        pct: clampPct(((end - now) / span) * 100),
        cycleKey: info.key,
      };
    }
    var next = end;
    if (billing.autoRenewal === "1" && months > 0) {
      var guard = 0;
      while (next <= now && guard++ < 600) next = addMonths(next, months);
      var diff = Math.round((next - now) / DAY_MS);
      return {
        days: diff,
        pct: clampPct((diff / (30 * months)) * 100),
        cycleKey: info.key,
      };
    }
    return {
      days: Math.round((end - now) / DAY_MS),
      pct: 0,
      cycleKey: info.key,
      expired: true,
    };
  }

  function parseTraffic(text) {
    var m = /^\s*([\d.]+)\s*([kKmMgGtTpP]?)i?[bB]?\s*$/.exec(String(text));
    if (!m) return 0;
    var n = parseFloat(m[1]);
    if (!isFinite(n)) return 0;
    var mult = { "": 1, K: KIB, M: KIB * KIB, G: KIB * KIB * KIB, T: Math.pow(KIB, 4) };
    return n * (mult[m[2].toUpperCase()] || 1);
  }

  /* --- state ------------------------------------------------------------ */

  var state = {
    setting: null,
    siteName: "",
    isMember: false,
    tsdb: false,
    customCode: "",
    servers: [],
    services: {},
    cycleByServer: {},
    serviceServerIds: {},
    groups: [],
    now: 0,
    connected: false,
    lastFrame: 0,
    onlineVisitors: 0,
    view: "card",
    sort: "default",
    country: "all",
    search: "",
    route: { name: "list", id: 0 },
    notes: {},
  };

  function loadStoredNotes() {
    try {
      state.notes = JSON.parse(sessionStorage.getItem(NOTE_KEY) || "{}") || {};
    } catch (e) {
      state.notes = {};
    }
  }

  // public_note rides only on the first WebSocket frame -- the dashboard drops
  // it afterwards to keep the stream small -- so it is kept for this tab.
  function rememberNotes(servers) {
    var changed = false;
    var live = {};
    servers.forEach(function (s) {
      live[s.id] = true;
      if (s.public_note) {
        state.notes[s.id] = s.public_note;
        changed = true;
      }
    });
    Object.keys(state.notes).forEach(function (id) {
      if (!live[id]) delete state.notes[id];
    });
    if (changed) {
      try {
        sessionStorage.setItem(NOTE_KEY, JSON.stringify(state.notes));
      } catch (e) {
        /* private mode: the notes simply do not survive a reload */
      }
    }
  }

  /* --- derived server model --------------------------------------------- */

  function decorate(server) {
    var host = server.host || {};
    var st = server.state || {};
    var lastActive = parseTime(server.last_active);
    // Three states, like the original: online / offline / never reported at
    // all -- a server whose agent has not checked in once is not merely down.
    var online = !!lastActive && state.now - lastActive <= OFFLINE_AFTER_MS;
    var everReported = !!lastActive;
    var cycle = state.cycleByServer[server.id] || null;
    var note = parsePublicNote(server.public_note || state.notes[server.id] || "");
    var used = Number(st.net_in_transfer || 0) + Number(st.net_out_transfer || 0);
    var quota = cycle && cycle.max ? cycle.max : note && note.plan ? parseTraffic(note.plan.trafficVol) : 0;

    return {
      id: server.id,
      name: server.name || String(server.id),
      host: host,
      state: st,
      online: online,
      everReported: everReported,
      lastActive: lastActive,
      country: server.country_code || "",
      platform: host.platform || "",
      arch: host.arch || "",
      virtualization: host.virtualization || "",
      cpu: Number(st.cpu || 0),
      memPct: ratio(st.mem_used, host.mem_total),
      swapPct: ratio(st.swap_used, host.swap_total),
      diskPct: ratio(st.disk_used, host.disk_total),
      quotaUsed: used,
      quota: quota,
      quotaPct: quota ? clampPct((used / quota) * 100) : null,
      upSpeed: Number(st.net_out_speed || 0),
      downSpeed: Number(st.net_in_speed || 0),
      upTransfer: Number(st.net_out_transfer || 0),
      downTransfer: Number(st.net_in_transfer || 0),
      uptime: Number(st.uptime || 0),
      load1: Number(st.load_1 || 0),
      load5: Number(st.load_5 || 0),
      load15: Number(st.load_15 || 0),
      tcp: Number(st.tcp_conn_count || 0),
      udp: Number(st.udp_conn_count || 0),
      processes: Number(st.process_count || 0),
      note: note,
      cycle: cycle,
      billing: note && note.billing ? billingLeft(note.billing) : null,
    };
  }

  function decorated() {
    return state.servers.map(decorate);
  }

  function countCountries(list) {
    var counts = {};
    list.forEach(function (s) {
      var cc = s.country || "??";
      counts[cc] = (counts[cc] || 0) + 1;
    });
    return Object.keys(counts)
      .map(function (cc) {
        return { code: cc, count: counts[cc] };
      })
      .sort(function (a, b) {
        return b.count - a.count || a.code.localeCompare(b.code);
      });
  }

  function visibleServers() {
    var list = decorated();
    if (state.country !== "all") {
      list = list.filter(function (s) {
        return (s.country || "??") === state.country;
      });
    }
    var q = state.search.trim().toLowerCase();
    if (q) {
      list = list.filter(function (s) {
        return (
          s.name.toLowerCase().indexOf(q) >= 0 ||
          s.platform.toLowerCase().indexOf(q) >= 0 ||
          s.arch.toLowerCase().indexOf(q) >= 0
        );
      });
    }
    return sortServers(list);
  }

  function sortServers(list) {
    var by = state.sort;
    if (by === "default") return list;
    var copy = list.slice();
    copy.sort(function (a, b) {
      switch (by) {
        case "cpu":
          return b.cpu - a.cpu;
        case "mem":
          return b.memPct - a.memPct;
        case "disk":
          return b.diskPct - a.diskPct;
        case "speed":
          return b.upSpeed + b.downSpeed - (a.upSpeed + a.downSpeed);
        case "name":
          return a.name.localeCompare(b.name, "zh-Hans-CN");
        default:
          return 0;
      }
    });
    return copy;
  }

  /* --- API -------------------------------------------------------------- */

  function getJSON(path) {
    return fetch(path, {
      credentials: "same-origin",
      headers: { Accept: "application/json" },
    })
      .then(function (res) {
        if (!res.ok) throw new Error(path + ": HTTP " + res.status);
        return res.json();
      })
      .then(function (body) {
        if (body && body.success === false) throw new Error(body.error || "request failed");
        return body && "data" in body ? body.data : body;
      });
  }

  function loadSetting() {
    return getJSON(API + "/setting")
      .then(function (data) {
        state.setting = data || {};
        var conf = (data && data.config) || {};
        var guests = conf.config_for_guests || {};
        state.siteName = guests.site_name || "";
        state.customCode = guests.custom_code || "";
        state.tsdb = !!(data && data.tsdb_enabled);
        var code = String(guests.language || "zh_CN");
        lang = /^en/i.test(code) ? "en" : "zh";
        document.documentElement.lang = lang === "en" ? "en" : "zh-CN";
      })
      .catch(function () {
        lang = /^en/i.test(navigator.language || "") ? "en" : "zh";
        ui.errorNotice = t("settingError");
      });
  }

  function loadMember() {
    return fetch(API + "/profile", { credentials: "same-origin" })
      .then(function (res) {
        state.isMember = res.ok;
      })
      .catch(function () {
        state.isMember = false;
      });
  }

  function loadServices() {
    return getJSON(API + "/service")
      .then(function (data) {
        state.services = (data && data.services) || {};
        var cycle = (data && data.cycle_transfer_stats) || {};
        // cycle_transfer_stats are keyed by rule and carry per-server totals:
        // the only place a traffic quota for a server can be read from.
        var byServer = {};
        Object.keys(cycle).forEach(function (id) {
          var rule = cycle[id] || {};
          var transfer = rule.transfer || {};
          var next = rule.next_update || {};
          Object.keys(transfer).forEach(function (sid) {
            byServer[sid] = {
              name: rule.name || "",
              max: Number(rule.max || 0),
              transfer: Number(transfer[sid] || 0),
              nextUpdate: next[sid] || null,
            };
          });
        });
        state.cycleByServer = byServer;
      })
      .catch(function () {
        /* service monitoring is optional on a dashboard */
      });
  }

  function loadServiceServers() {
    return getJSON(API + "/service/server")
      .then(function (ids) {
        var map = {};
        (ids || []).forEach(function (id) {
          map[id] = true;
        });
        state.serviceServerIds = map;
      })
      .catch(function () {
        state.serviceServerIds = {};
      });
  }

  function loadGroups() {
    return getJSON(API + "/service-groups")
      .then(function (list) {
        state.groups = (list || []).map(function (item) {
          return {
            id: item.group && item.group.id,
            name: (item.group && item.group.name) || "",
            servers: item.servers || [],
          };
        });
      })
      .catch(function () {
        state.groups = [];
      });
  }

  var probeCache = {};
  var probeQueue = [];
  var probeActive = 0;

  function wantProbes(id) {
    var hit = probeCache[id];
    if (hit && Date.now() - hit.at < PROBE_TTL_MS) return;
    if (probeQueue.indexOf(id) < 0) probeQueue.push(id);
    pumpProbeQueue();
  }

  function pumpProbeQueue() {
    while (probeActive < 4 && probeQueue.length) {
      var id = probeQueue.shift();
      probeActive++;
      (function (serverId) {
        getJSON(API + "/server/" + serverId + "/service?period=1d")
          .then(function (list) {
            probeCache[serverId] = { at: Date.now(), list: list || [] };
          })
          .catch(function () {
            probeCache[serverId] = { at: Date.now(), list: [] };
          })
          .then(function () {
            probeActive--;
            paintProbes(serverId);
            pumpProbeQueue();
          });
      })(id);
    }
  }

  /* --- websocket -------------------------------------------------------- */

  var socket = null;
  var reconnectDelay = 1000;
  var reconnectTimer = null;
  var warned = false;

  function connect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    var proto = location.protocol === "https:" ? "wss://" : "ws://";
    try {
      socket = new WebSocket(proto + location.host + API + "/ws/server");
    } catch (e) {
      scheduleReconnect();
      return;
    }
    socket.onopen = function () {
      reconnectDelay = 1000;
      state.connected = true;
      warned = false;
      paintStatus();
      loadServices().then(function () {
        loadServiceServers().then(function () {
          refreshVisibleProbes();
          update();
        });
      });
    };
    socket.onmessage = function (ev) {
      var frame;
      try {
        frame = JSON.parse(ev.data);
      } catch (e) {
        return;
      }
      if (!frame || !frame.servers) return;
      state.now = Number(frame.now) || Date.now();
      state.onlineVisitors = Number(frame.online || 0);
      rememberNotes(frame.servers);
      state.servers = frame.servers;
      state.lastFrame = Date.now();
      update();
      refreshVisibleProbes();
    };
    socket.onclose = function () {
      state.connected = false;
      paintStatus();
      scheduleReconnect();
    };
    socket.onerror = function () {
      if (warned) return;
      warned = true;
      if (!state.servers.length) ui.errorNotice = t("wsError");
    };
  }

  function scheduleReconnect() {
    if (reconnectTimer) return;
    reconnectTimer = setTimeout(function () {
      reconnectTimer = null;
      reconnectDelay = Math.min(reconnectDelay * 2, 15000);
      connect();
    }, reconnectDelay);
  }

  function refreshVisibleProbes() {
    if (!Object.keys(state.serviceServerIds).length) return;
    visibleServers()
      .slice(0, PROBE_MAX_SERVERS)
      .forEach(function (s) {
        if (state.serviceServerIds[s.id]) wantProbes(s.id);
      });
  }

  /* --- shell ------------------------------------------------------------ */

  var ui = { root: document.getElementById("root") };
  var views = { card: {}, ring: {}, table: {} };

  function buildShell() {
    var titleText = h("span", {
      class: "title-bar-text",
      text: state.siteName || t("title"),
    });

    var titleBar = h("div", { class: "title-bar" }, [
      monitorIcon("title-bar-icon"),
      titleText,
      h("div", { class: "traffic-lights" }, [
        h("i", { class: "tl-close" }),
        h("i", { class: "tl-min" }),
        h("i", { class: "tl-zoom" }),
      ]),
      h("div", { class: "title-buttons" }, [
        buildSkinMenu(),
        buildSchemeMenu(),
        h("a", {
          class: "title-btn title-btn-last",
          href: "/dashboard/",
          title: t("adminPanel"),
          "aria-label": t("adminPanel"),
          "data-tip": t("adminPanel"),
        }, [icon("gear", 12)]),
        h("button", {
          class: "title-btn",
          type: "button",
          "data-tip": t("about"),
          text: "?",
          onclick: showAbout,
        }),
      ]),
    ]);

    var toolbar = h("div", { class: "toolbar" }, [
      viewButton("card", t("viewCard")),
      viewButton("ring", t("viewRing")),
      viewButton("table", t("viewTable")),
      h("div", { class: "tool-sep" }),
      h("span", { class: "tool-label", id: "fleet-count" }),
      h("div", { class: "tool-spacer" }),
      h("label", { class: "field", "data-tip": t("find") }, [
        h("input", {
          class: "input",
          type: "search",
          placeholder: t("findPlaceholder"),
          autocomplete: "off",
          oninput: function () {
            state.search = this.value;
            renderList();
          },
        }),
      ]),
      h("label", { class: "field", "data-tip": t("sortBy") }, [
        h(
          "select",
          {
            class: "select",
            onchange: function () {
              state.sort = this.value;
              renderList();
            },
          },
          [
            h("option", { value: "default", text: t("sortDefault") }),
            h("option", { value: "cpu", text: t("sortCpu") }),
            h("option", { value: "mem", text: t("sortMem") }),
            h("option", { value: "disk", text: t("sortDisk") }),
            h("option", { value: "speed", text: t("sortSpeed") }),
            h("option", { value: "name", text: t("sortName") }),
          ]
        ),
      ]),
    ]);

    ui.filterBar = h("div", { class: "filters" });
    ui.summary = h("div", { class: "summary" });
    ui.listPane = h("div", { class: "panel" });
    ui.customCode = h("div", { class: "custom-code", hidden: !state.customCode });
    if (state.customCode) ui.customCode.innerHTML = state.customCode;
    ui.statusBar = h("div", { class: "status-bar" });
    ui.titleText = titleText;
    ui.appTitleBar = titleBar;
    ui.fleetCount = toolbar.querySelector("#fleet-count");
    ui.toolbar = toolbar;

    ui.pageContent = h("div", { class: "page-content" }, [
      ui.filterBar,
      ui.summary,
      ui.listPane,
      ui.customCode,
    ]);

    ui.appWindow = h("div", { class: "app-window win" }, [
      titleBar,
      h("div", { class: "app-body" }, [
        h("div", { class: "page" }, [toolbar, ui.pageContent, ui.statusBar]),
      ]),
    ]);

    clear(ui.root).appendChild(h("div", { class: "desktop" }, ui.appWindow));
  }

  function viewButton(view, label) {
    var on = state.view === view;
    return h(
      "button",
      {
        class: "tool-btn" + (on ? " active" : ""),
        type: "button",
        dataset: { view: view },
        "aria-pressed": on ? "true" : "false",
        onclick: function () {
          setView(view);
        },
      },
      [icon(view === "card" ? "cards" : view), label]
    );
  }

  function setView(view) {
    state.view = view;
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch (e) {
      /* ignore */
    }
    Array.prototype.forEach.call(
      ui.appWindow.querySelectorAll("[data-view]"),
      function (btn) {
        var on = btn.dataset.view === view;
        btn.classList.toggle("active", on);
        btn.setAttribute("aria-pressed", on ? "true" : "false");
      }
    );
    views = { card: {}, ring: {}, table: {} };
    renderList();
  }

  function menuButton(label, items, current, face) {
    var wrap = h("div", { class: "menu-wrap" });
    var list = h("div", { class: "menu", hidden: true });
    var open = false;

    items.forEach(function (item) {
      list.appendChild(
        h(
          "button",
          {
            class: "menu-item",
            type: "button",
            role: "menuitemradio",
            "aria-checked": current() === item.id ? "true" : "false",
            onclick: function () {
              close();
              item.run();
            },
          },
          [
            h("span", {
              class: "menu-check",
              text: current() === item.id ? "✔" : "",
            }),
            h("span", { class: "menu-label", text: item.label }),
            item.icon ? icon(item.icon, 12) : null,
          ]
        )
      );
    });

    var button = h(
      "button",
      {
        class: "title-btn",
        type: "button",
        "aria-haspopup": "true",
        "aria-expanded": "false",
        "data-tip": label,
        onclick: function (ev) {
          ev.stopPropagation();
          open = !open;
          list.hidden = !open;
          button.setAttribute("aria-expanded", open ? "true" : "false");
        },
      },
      // The face is a glyph, the way the OS drew its caption buttons; the
      // label lives in the tooltip.
      [face && face.icon ? icon(face.icon(), 12) : h("span", { text: label })]
    );

    function close() {
      open = false;
      list.hidden = true;
      button.setAttribute("aria-expanded", "false");
    }
    function refresh() {
      Array.prototype.forEach.call(list.children, function (node, i) {
        var on = current() === items[i].id;
        node.setAttribute("aria-checked", on ? "true" : "false");
        node.firstChild.textContent = on ? "✔" : "";
      });
    }

    list.addEventListener("click", function (ev) {
      ev.stopPropagation();
    });
    document.addEventListener("click", function () {
      if (open) close();
    });

    wrap.appendChild(button);
    wrap.appendChild(list);
    wrap.refresh = refresh;
    wrap.button = button;
    return wrap;
  }

  var SKINS = [
    { id: "", key: "skin2000" },
    { id: "win31", key: "skin31" },
    { id: "xp", key: "skinXp" },
    { id: "aqua", key: "skinAqua" },
  ];

  function buildSkinMenu() {
    var wrap = menuButton(t("skin"), SKINS.map(function (skin) {
      return {
        id: skin.id,
        label: t(skin.key),
        run: function () {
          applySkin(skin.id);
        },
      };
    }), function () {
      return document.body.dataset.skin || "";
    }, { icon: function () { return "skin"; } });
    wrap.button.setAttribute("data-tip", t("skin") + " · " + skinLabel());
    wrap.refresh();
    ui.skinMenu = wrap;
    return wrap;
  }

  function skinLabel() {
    var skin = document.body.dataset.skin || "";
    if (skin === "win31") return t("skin31");
    if (skin === "xp") return t("skinXp");
    if (skin === "aqua") return t("skinAqua");
    return t("skin2000");
  }

  function applySkin(skin) {
    if (skin) document.body.dataset.skin = skin;
    else delete document.body.dataset.skin;
    try {
      localStorage.setItem(SKIN_KEY, JSON.stringify(skin || null));
    } catch (e) {
      /* ignore */
    }
    if (ui.skinMenu) {
      ui.skinMenu.button.setAttribute("data-tip", t("skin") + " · " + skinLabel());
      ui.skinMenu.refresh();
    }
    redrawCharts();
  }

  function storedScheme() {
    try {
      // Same default as the pre-paint script in index.html: the classic light
      // palette, with "auto" available as a choice rather than as the default.
      var value = JSON.parse(localStorage.getItem(SCHEME_KEY) || '"light"');
      return value === "light" || value === "dark" || value === "auto" ? value : "light";
    } catch (e) {
      return "light";
    }
  }

  function isDarkNow(scheme) {
    if (scheme === "dark") return true;
    if (scheme === "light") return false;
    return matchMedia("(prefers-color-scheme: dark)").matches;
  }

  function buildSchemeMenu() {
    var wrap = menuButton(
      t("scheme"),
      [
        { id: "auto", key: "schemeAuto", icon: "gear" },
        { id: "light", key: "schemeLight", icon: "sun" },
        { id: "dark", key: "schemeDark", icon: "moon" },
      ].map(function (item) {
        return {
          id: item.id,
          label: t(item.key),
          icon: item.icon,
          run: function () {
            applyScheme(item.id);
          },
        };
      }),
      storedScheme,
      { icon: function () { return isDarkNow(storedScheme()) ? "moon" : "sun"; } }
    );
    ui.schemeMenu = wrap;
    syncSchemeButton();
    applySchemeClass(storedScheme());
    return wrap;
  }

  function syncSchemeButton() {
    if (ui.schemeMenu) {
      clear(ui.schemeMenu.button).appendChild(
        icon(isDarkNow(storedScheme()) ? "moon" : "sun", 12)
      );
    }
  }

  function applySchemeClass(scheme) {
    document.body.classList.toggle("light", !isDarkNow(scheme));
  }

  function applyScheme(scheme) {
    try {
      localStorage.setItem(SCHEME_KEY, JSON.stringify(scheme));
    } catch (e) {
      /* ignore */
    }
    applySchemeClass(scheme);
    syncSchemeButton();
    if (ui.schemeMenu) ui.schemeMenu.refresh();
    redrawCharts();
  }

  function showAbout() {
    dialog(t("aboutTitle"), [
      h("p", { text: t("aboutTheme") }),
      h("p", { text: t("aboutSkin") }),
      h("p", { text: t("aboutData") }),
    ]);
  }

  function dialog(title, bodyNodes, actions) {
    var overlay = h("div", { class: "dialog-overlay" });
    var box = h("div", { class: "dialog win" }, [
      h("div", { class: "title-bar" }, [
        h("span", { class: "title-bar-text", text: title }),
        h("div", { class: "title-buttons" }, [
          h(
            "button",
            {
              class: "title-btn",
              type: "button",
              "aria-label": t("close"),
              text: "×",
              onclick: function () {
                close();
              },
            }
          ),
        ]),
      ]),
      h("div", { class: "dialog-body" }, [
        svgMarkup(
          '<svg viewBox="0 0 32 32" width="32" height="32">' +
            '<circle cx="16" cy="16" r="15" fill="#ffffe1" stroke="#000"/>' +
            '<text x="16" y="23" font-size="19" font-family="Tahoma,SimSun,sans-serif" text-anchor="middle">i</text>' +
            "</svg>",
          "dialog-icon"
        ),
        h("div", { class: "dialog-message" }, bodyNodes),
      ]),
      h(
        "div",
        { class: "dialog-buttons" },
        actions && actions.length
          ? actions
          : [
              h("button", {
                class: "btn",
                type: "button",
                text: t("cancel"),
                onclick: function () {
                  close();
                },
              }),
            ]
      ),
    ]);

    function close() {
      if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
      document.removeEventListener("keydown", onKey);
    }
    function onKey(ev) {
      if (ev.key === "Escape") close();
    }
    overlay.addEventListener("click", function (ev) {
      if (ev.target === overlay) close();
    });
    document.addEventListener("keydown", onKey);
    overlay.appendChild(box);
    document.body.appendChild(overlay);
  }

  /* --- paint: summary, filters, status ---------------------------------- */

  function paintSummary() {
    var list = decorated();
    var online = list.filter(function (s) {
      return s.online;
    }).length;
    var online2 = list.length - online;
    var upSpeed = 0;
    var downSpeed = 0;
    var upTransfer = 0;
    var downTransfer = 0;
    var busiest = null;
    list.forEach(function (s) {
      upSpeed += s.upSpeed;
      downSpeed += s.downSpeed;
      upTransfer += s.upTransfer;
      downTransfer += s.downTransfer;
      if (!busiest || s.cpu > busiest.cpu) busiest = s;
    });

    clear(ui.summary);

    ui.summary.appendChild(
      h("fieldset", { class: "groupbox" }, [
        h("legend", { text: t("fleet") }),
        h("span", { class: "stat-figure" }, [
          h("span", { class: "stat-big" }, [
            h("span", { class: "text-online num", text: String(online) }),
            h("span", { class: "stat-sep", text: " / " }),
            h("span", {
              class: online2 ? "text-offline num" : "text-gray num",
              text: String(online2),
            }),
            h("span", { class: "stat-sub", style: "display:inline" }, [
              h("i", { text: "  " + t("online") + " / " + t("offline") }),
            ]),
          ]),
        ]),
        h(
          "div",
          { class: "fleet-bar" },
          list.map(function (s) {
            return h("i", { class: s.online ? "" : "off", "data-tip": s.name });
          })
        ),
      ])
    );

    ui.summary.appendChild(
      h("fieldset", { class: "groupbox stat-summary-extra" }, [
        h("legend", { text: t("speed") }),
        h("span", { class: "stat-figure" }, [
          h("span", { class: "stat-big num", text: speedText(upSpeed + downSpeed) }),
          h("span", { class: "stat-sub" }, [
            h("i", { text: "↑ " + speedText(upSpeed) + "   ↓ " + speedText(downSpeed) }),
          ]),
        ]),
      ])
    );

    var total = upTransfer + downTransfer;
    ui.summary.appendChild(
      h("fieldset", { class: "groupbox stat-summary-extra" }, [
        h("legend", { text: t("traffic") }),
        h("span", { class: "stat-figure" }, [
          h("span", { class: "stat-big num", text: byteText(total) }),
          h("span", { class: "stat-sub" }, [
            h("i", { text: "↑ " + byteText(upTransfer) }),
            h("span", { class: "stat-sep", text: "   ↓ " }),
            h("i", { text: byteText(downTransfer) }),
          ]),
        ]),
      ])
    );

    var busyPct = busiest ? clampPct(busiest.cpu) : 0;
    ui.summary.appendChild(
      h("fieldset", { class: "groupbox stat-busy stat-summary-extra" }, [
        h("legend", { text: t("busiest") }),
        h("span", { class: "stat-busy-name num", text: busiest ? busiest.name : "—" }),
        h("span", { class: "num", text: percentText(busyPct) }),
        h("div", { class: "progress" }, [
          h("span", {
            class: "progress-fill" + (busyPct >= HOT_AT ? " hot" : ""),
            style: "width:" + busyPct + "%",
          }),
        ]),
      ])
    );
  }

  function paintFilters() {
    var counts = countCountries(decorated());
    var sig = counts
      .map(function (c) {
        return c.code + ":" + c.count;
      })
      .join(",");
    if (ui.filterSig === sig && ui.filterActive === state.country) return;
    ui.filterSig = sig;
    ui.filterActive = state.country;

    clear(ui.filterBar);
    var row = h("div", { class: "toolbar" }, [
      filterToggle("all", t("all"), state.servers.length, null),
    ]);
    counts.slice(0, 8).forEach(function (c) {
      row.appendChild(filterToggle(c.code, countryName(c.code), c.count, c.code));
    });

    var rest = counts.slice(8);
    if (rest.length) {
      var menu = h("div", { class: "menu menu-scroll", hidden: true });
      rest.forEach(function (c) {
        menu.appendChild(
          h(
            "button",
            {
              class: "menu-item",
              type: "button",
              "aria-label": countryName(c.code) + " · " + c.count + " " + t("units"),
              onclick: function (ev) {
                ev.stopPropagation();
                menu.hidden = true;
                pickCountry(c.code);
              },
            },
            [
              flagNode(c.code),
              h("span", { class: "menu-label", text: countryName(c.code) }),
              h("span", { class: "toggle-count num", text: String(c.count) }),
            ]
          )
        );
      });
      var wrap = h("div", { class: "menu-wrap" });
      var inRest = rest.some(function (c) {
        return c.code === state.country;
      });
      wrap.appendChild(
        h("button", {
          class: "toggle",
          type: "button",
          "aria-pressed": inRest ? "true" : "false",
          onclick: function (ev) {
            ev.stopPropagation();
            menu.hidden = !menu.hidden;
          },
        }, [h("span", { class: "toggle-box" }), t("more") + "…"])
      );
      menu.addEventListener("click", function (ev) {
        ev.stopPropagation();
      });
      wrap.appendChild(menu);
      row.appendChild(wrap);
    }
    ui.filterBar.appendChild(row);
  }

  function filterToggle(code, label, count, flagCode) {
    return h(
      "button",
      {
        class: "toggle",
        type: "button",
        dataset: { country: code },
        "aria-pressed": state.country === code ? "true" : "false",
        "aria-label":
          code === "all"
            ? label
            : countryName(code) + " · " + count + " " + t("units"),
        onclick: function () {
          pickCountry(code);
        },
      },
      [
        flagCode ? flagNode(flagCode) : h("span", { class: "toggle-box" }),
        label,
        h("span", { class: "toggle-count num", text: String(count) }),
      ]
    );
  }

  function pickCountry(code) {
    state.country = state.country === code && code !== "all" ? "all" : code;
    ui.filterSig = null;
    paintFilters();
    renderList();
  }

  function paintStatus() {
    clear(ui.statusBar);
    // A window whose data stream is down is drawn the way the OS drew an
    // inactive window: the caption loses its gradient.
    if (ui.appTitleBar) ui.appTitleBar.classList.toggle("inactive", !state.connected);
    var list = decorated();
    var online = list.filter(function (s) {
      return s.online;
    }).length;

    ui.statusBar.appendChild(
      h("div", { class: "status-field grow" }, [
        h("i", { class: "led" + (state.connected ? " on" : "") }),
        h("span", {
          text:
            (state.connected ? t("connected") : t("reconnecting")) +
            " · " +
            online +
            " " +
            t("online") +
            " / " +
            (list.length - online) +
            " " +
            t("offline"),
        }),
      ])
    );

    if (ui.errorNotice) {
      ui.statusBar.appendChild(
        h("div", { class: "status-field", text: ui.errorNotice })
      );
    }

    ui.statusBar.appendChild(
      h("div", { class: "status-field" }, [
        h("span", { text: t("visitor") + " " }),
        h("span", { class: "num", text: String(state.onlineVisitors) }),
      ])
    );

    ui.statusBar.appendChild(
      h("div", { class: "status-field" }, [
        h("span", {
          class: "num",
          text: state.lastFrame
            ? t("updated") + " " + timeText(state.lastFrame)
            : t("connecting"),
        }),
      ])
    );

    var version = state.setting && state.setting.version ? state.setting.version : "";
    ui.statusBar.appendChild(
      h("div", { class: "status-field" }, [
        h("a", {
          href: "https://github.com/nezhahq/nezha",
          target: "_blank",
          rel: "noreferrer",
          text: t("poweredBy") + (version ? " " + version : ""),
        }),
      ])
    );
  }

  /* --- paint: server list ----------------------------------------------- */

  function renderList() {
    if (state.route.name !== "list") return;
    if (ui.titleText) ui.titleText.textContent = state.siteName || t("title");
    var list = visibleServers();
    if (ui.fleetCount) ui.fleetCount.textContent = list.length + " " + t("units");

    clear(ui.listPane);
    if (!list.length) {
      var emptyKey = state.servers.length
        ? state.country !== "all" && !state.search.trim()
          ? "regionEmpty"
          : "noMatch"
        : "noServers";
      ui.listPane.appendChild(
        h("p", { class: "empty-state text-muted", text: t(emptyKey) })
      );
      return;
    }
    var grid;
    if (state.view === "card") grid = buildCards(list);
    else if (state.view === "ring") grid = buildRings(list);
    else grid = buildTable(list);
    ui.listPane.appendChild(grid);
    // Probe data may already be cached; paint it now rather than waiting for
    // the next fetch to come back.
    list.forEach(function (s) {
      paintProbes(s.id);
    });
  }

  function update() {
    if (state.route.name === "list") {
      renderList();
      paintSummary();
      paintFilters();
    } else if (
      !ui.detail ||
      String(ui.detail.server.id) !== String(state.route.id)
    ) {
      // A direct hit on /server/<id> routes before the first frame arrives, so
      // the page has to be built on the frame that finally carries the server.
      renderDetail(state.route.id);
    } else {
      renderDetailValues();
    }
    paintStatus();
  }

  function buildCards(list) {
    views.card = {};
    var grid = h("div", { class: "servers-grid" });
    list.forEach(function (s) {
      var card = cardNode(s);
      views.card[s.id] = card;
      grid.appendChild(card.el);
    });
    return grid;
  }

  function buildRings(list) {
    views.ring = {};
    var grid = h("div", { class: "servers-grid view-ring" });
    list.forEach(function (s) {
      var card = cardNode(s);
      var body = card.el.querySelector(".card-body");
      var meters = card.meters.el;
      if (meters.parentNode) meters.parentNode.removeChild(meters);
      var rings = ringBlock();
      body.insertBefore(rings.el, card.el.querySelector(".card-data"));
      card.rings = rings;
      paintRings(card, s);
      views.ring[s.id] = card;
      grid.appendChild(card.el);
    });
    return grid;
  }

  function cardNode(s) {
    // The whole card is one link, like the original: click opens the monitor
    // page, middle click opens it in a new tab.  The nested card-link is gone
    // because an anchor cannot contain another.
    var stateCls = s.online ? "online" : s.everReported ? "offline" : "unseen";
    var statusLed = h("i", { class: "led" + (s.online ? " on" : "") });
    var statusText = h("span", {
      class: s.online ? "text-online" : "text-offline",
      text: s.online ? t("online") : s.everReported ? t("offline") : t("neverSeen"),
    });
    var metaState = h("span", { class: "card-meta-item" });
    var metaVirt = h("span", { class: "card-meta-item card-meta-right" });
    var metaArch = h("span", { class: "card-meta-item card-meta-right" });
    // The platform never changes while the page is open, so its icon is
    // resolved once at build time rather than on every frame.  It sits in the
    // caption, beside the flag, where the original wears it.
    var titleOs = osIcon(s.platform);

    var meters = {
      cpu: meterRow(t("cpu")),
      mem: meterRow(t("memory")),
      disk: meterRow(t("disk")),
      quota: meterRow(t("usage")),
    };
    var metersEl = h("div", { class: "meters" }, [
      meters.cpu.el,
      meters.mem.el,
      meters.disk.el,
      meters.quota.el,
    ]);
    meters.el = metersEl;

    var reads = {
      upSpeed: readRow("↑", "read-up"),
      downSpeed: readRow("↓", "read-down"),
      upTotal: readRow("↑", "read-up"),
      downTotal: readRow("↓", "read-down"),
      extraA: readRow("", "read-plain"),
      extraB: readRow("", "read-plain"),
    };
    var probes = h("div", { class: "probes" });

    var el = h("a", { class: "server-card win " + stateCls, href: "/server/" + s.id }, [
      h("div", { class: "title-bar" + (s.online ? "" : " inactive") }, [
        flagNode(s.country),
        titleOs,
        h("span", { class: "title-bar-text", text: s.name }),
        h("span", { class: "card-status" }, [statusLed, statusText]),
      ]),
      h("div", { class: "card-body" }, [
        h("div", { class: "card-meta" }, [
          metaState,
          h("span", { class: "card-meta-spacer" }),
          metaVirt,
          metaArch,
        ]),
        metersEl,
        h("div", { class: "card-data" }, [
          h("div", { class: "reads" }, [
            h("div", { class: "read-col" }, [reads.upSpeed.el, reads.downSpeed.el]),
            h("div", { class: "read-col" }, [reads.upTotal.el, reads.downTotal.el]),
            h("div", { class: "read-col" }, [reads.extraA.el, reads.extraB.el]),
          ]),
          probes,
        ]),
      ]),
    ]);

    var card = {
      el: el,
      id: s.id,
      statusLed: statusLed,
      statusText: statusText,
      metaState: metaState,
      metaVirt: metaVirt,
      metaArch: metaArch,
      meters: meters,
      reads: reads,
      probes: probes,
      rings: null,
    };
    paintCard(card, s);
    return card;
  }

  function meterRow(label) {
    var fill = h("span", { class: "progress-fill" });
    var value = h("span", { class: "num" });
    var el = h("div", { class: "meter-row" }, [
      h("span", { class: "meter-label", text: label }),
      h("div", { class: "progress" }, fill),
      value,
    ]);
    return {
      el: el,
      fill: fill,
      value: value,
      show: function (visible) {
        el.hidden = !visible;
      },
      set: function (text, pct, hot) {
        value.textContent = text;
        fill.style.width = clampPct(pct) + "%";
        fill.classList.toggle("hot", !!hot);
      },
    };
  }

  function readRow(arrow, cls) {
    var value = h("b");
    var unit = h("i", { class: "read-unit" });
    var text = h("span", { class: "read-text" });
    var el = h("span", { class: "read " + cls }, [
      h("span", { class: "read-icon", text: arrow }),
      value,
      unit,
      text,
    ]);
    return {
      el: el,
      set: function (v, unitText, extra) {
        value.textContent = v == null ? "—" : String(v);
        unit.textContent = unitText || "";
        text.textContent = extra || "";
      },
      tip: function (tipText) {
        if (tipText) el.setAttribute("data-tip", tipText);
        else el.removeAttribute("data-tip");
      },
    };
  }

  function paintCard(card, s) {
    card.statusLed.className = "led" + (s.online ? " on" : "");
    card.statusText.className = s.online ? "text-online" : "text-offline";
    card.statusText.textContent = s.online
      ? t("online")
      : s.everReported
        ? t("offline")
        : t("neverSeen");

    card.metaState.textContent = s.online
      ? t("uptimePrefix") + " " + durationShort(s.uptime)
      : s.everReported
        ? t("offlinePrefix") + " " + durationShort((state.now - s.lastActive) / 1000)
        : t("neverSeen");
    card.metaVirt.textContent = s.virtualization || "";
    card.metaArch.textContent = s.arch || "";

    card.meters.cpu.set(percentText(s.cpu), s.cpu, s.cpu >= HOT_AT);
    card.meters.mem.set(percentText(s.memPct), s.memPct, s.memPct >= HOT_AT);
    card.meters.disk.set(percentText(s.diskPct), s.diskPct, s.diskPct >= HOT_AT);
    // The quota row always shows: without a quota it draws an empty trough
    // with the infinity sign, which keeps the four meters on every card at the
    // same height, like the original.
    card.meters.quota.show(true);
    if (s.quotaPct != null) {
      card.meters.quota.set(percentText(s.quotaPct, 1), s.quotaPct, s.quotaPct >= HOT_AT);
    } else {
      card.meters.quota.set("∞", 0, false);
    }

    var reads = card.reads;
    var up = bytes(s.upSpeed);
    var down = bytes(s.downSpeed);
    var upTotal = bytes(s.upTransfer);
    var downTotal = bytes(s.downTransfer);
    reads.upSpeed.set(up.v, up.u + "/s");
    reads.downSpeed.set(down.v, down.u + "/s");
    reads.upTotal.set(upTotal.v, upTotal.u);
    reads.downTotal.set(downTotal.v, downTotal.u);
    // Traffic tooltip: what the current cycle has spent, when a quota rule
    // covers this server.
    if (s.cycle && s.cycle.max) {
      var cycleTip =
        t("cycleTraffic") + " ↓ " + byteText(s.cycle.transfer) + " / " + byteText(s.cycle.max);
      reads.upTotal.tip(cycleTip);
      reads.downTotal.tip(cycleTip);
    } else {
      reads.upTotal.tip("");
      reads.downTotal.tip("");
    }

    // Third column: the paid cycle when the note carries one, otherwise the
    // operational figures that would otherwise have nowhere to go.
    var note = s.note || {};
    var billing = s.billing;
    if (billing && billing.forever) {
      reads.extraA.set(t("remaining"), "", "∞");
    } else if (billing && billing.days != null) {
      reads.extraA.set(
        t("remaining"),
        "",
        billing.expired
          ? t("expired") + " " + Math.abs(billing.days) + " " + t("forDays")
          : Math.abs(billing.days) + " " + t("forDays")
      );
    } else {
      reads.extraA.set(t("load"), "", s.load1.toFixed(2));
    }

    if (note.billing && note.billing.amount !== "") {
      var priceText;
      if (note.billing.amount === "0") priceText = t("free");
      else if (note.billing.amount === "-1") priceText = t("usageBased");
      else priceText = note.billing.amount + " / " + t(cycleInfo(note.billing.cycle).key);
      reads.extraB.set(t("price"), "", priceText);
      reads.extraB.el.setAttribute("title", t("renew") + " " + priceText);
    } else {
      reads.extraB.set("TCP", "", String(s.tcp));
      reads.extraB.el.removeAttribute("title");
    }
  }

  function paintProbes(id) {
    [views.card[id], views.ring[id]].forEach(function (card) {
      if (card && card.probes) paintCardProbes(card.probes, id);
    });
  }

  // Latency colouring, the original's scale: under 100ms green, under 200
  // yellow, everything else red; a failed check draws in the offline colour.
  function rttColor(ms) {
    if (ms == null || ms <= 0) return "var(--offline)";
    if (ms < 100) return "var(--accent-green)";
    if (ms < 200) return "var(--accent-yellow)";
    return "var(--offline)";
  }

  function lossLevel(loss) {
    return loss <= 0 ? "ok" : loss < 5 ? "warn" : "bad";
  }

  function lossColor(loss) {
    return loss <= 0
      ? "var(--accent-green)"
      : loss < 5
        ? "var(--accent-yellow)"
        : "var(--offline)";
  }

  // Fold a delay series into `count` buckets.  A bucket where most samples
  // came back as zero (nezha records 0 delay for a failed check) counts as
  // failed rather than as "0 ms", which would otherwise look like fibre.
  function delayBuckets(series, count) {
    var buckets = [];
    if (!series || !series.length) return buckets;
    var step = Math.max(1, Math.ceil(series.length / count));
    for (var i = 0; i < series.length; i += step) {
      var sum = 0;
      var n = 0;
      var bad = 0;
      for (var j = i; j < series.length && j < i + step; j++) {
        var v = Number(series[j] || 0);
        sum += v;
        n++;
        if (v <= 0) bad++;
      }
      buckets.push({ value: n ? sum / n : 0, failed: bad * 2 >= n });
    }
    return buckets;
  }

  function paintCardProbes(container, id) {
    var hit = probeCache[id];
    if (!hit) return;
    var list = hit.list;
    clear(container);
    if (!list.length) return;
    var shown = list.slice(0, 4);
    shown.forEach(function (info) {
      // model.ServiceInfos is serialised under the legacy monitor_* names, not
      // the Go field names, so the id, label and series are read from those.
      var stats = state.services[info.monitor_id] || {};
      var series = info.avg_delay || [];
      var last = series.length ? Number(series[series.length - 1]) : null;
      var lastOk = last != null && last > 0;
      var downRate = dayDownRate(stats);
      var rttBuckets = delayBuckets(series, 30);
      container.appendChild(
        h("div", { class: "probe-row" }, [
          h("span", {
            class: "probe-name",
            text: info.monitor_name || String(info.monitor_id),
            "data-tip": info.monitor_name || "",
          }),
          h("span", {
            class: "probe-ms num",
            style: last == null ? "" : "color:" + (lastOk ? rttColor(last) : "var(--offline)"),
            text: last == null ? "—" : lastOk ? Math.round(last) + " ms" : t("timeout"),
          }),
          rttStrip(rttBuckets),
          h("span", {
            class: "probe-loss num loss-" + lossLevel(downRate),
            text: downRate.toFixed(1) + "%",
          }),
          lossStrip(stats),
        ])
      );
    });
    if (list.length > shown.length) {
      container.appendChild(
        h("div", {
          class: "probe-more",
          text: t("showMore", { n: list.length - shown.length }),
        })
      );
    }
  }

  // The wide strip: each cell is one bucket of the delay window, coloured by
  // how fast that bucket answered -- the original's RTT pill strip.
  function rttStrip(buckets) {
    var cells = buckets.map(function (b) {
      return h("i", {
        style: "background:" + (b.failed ? "var(--offline)" : rttColor(b.value)),
      });
    });
    return h(
      "span",
      { class: "strip", "data-tip": t("bucketRtt") },
      cells
    );
  }

  // The thin strip: one cell per day of the 30-day window, coloured by that
  // day's loss ratio.
  function lossStrip(stats) {
    var up = (stats && stats.up) || [];
    var down = (stats && stats.down) || [];
    var cells = [];
    for (var i = 0; i < 30; i++) {
      var u = Number(up[i] || 0);
      var d = Number(down[i] || 0);
      if (u + d === 0) {
        cells.push(h("i", { class: "idle" }));
      } else {
        var dayLoss = (d / (u + d)) * 100;
        cells.push(h("i", { style: "background:" + lossColor(dayLoss) }));
      }
    }
    return h("span", { class: "strip thin", "data-tip": t("bucketLoss") }, cells);
  }

  // Failed checks over all checks today -- the same loss rate the official
  // frontend shows for the current day, falling back to the 30-day totals when
  // today has no checks yet.
  function dayDownRate(stats) {
    var up = Number(stats.current_up || 0);
    var down = Number(stats.current_down || 0);
    if (!up && !down) {
      up = Number(stats.total_up || 0);
      down = Number(stats.total_down || 0);
    }
    if (!up && !down) return 0;
    return (down / (up + down)) * 100;
  }



  function ringBlock() {
    var cpu = ringGauge(t("cpu"));
    var mem = ringGauge(t("memory"));
    var disk = ringGauge(t("disk"));
    return {
      el: h("div", { class: "rings" }, [cpu.el, mem.el, disk.el]),
      cpu: cpu,
      mem: mem,
      disk: disk,
    };
  }

  function ringGauge(label) {
    var top = h("span", { class: "cylinder-top" });
    var side = h("span", { class: "cylinder-side" });
    var value = h("span", { class: "ring-value num" });
    return {
      el: h("div", { class: "ring-item" }, [
        h("span", { class: "cylinder" }, [side, top, value]),
        h("span", { class: "ring-label", text: label }),
      ]),
      set: function (pct, text) {
        pct = clampPct(pct);
        top.style.setProperty("--pct", pct + "%");
        side.style.setProperty("--pct", pct + "%");
        value.textContent = text;
      },
    };
  }

  function paintRings(card, s) {
    if (!card.rings) return;
    card.rings.cpu.set(s.cpu, percentText(s.cpu, 0));
    card.rings.mem.set(s.memPct, percentText(s.memPct, 0));
    card.rings.disk.set(s.diskPct, percentText(s.diskPct, 0));
  }

  function buildTable(list) {
    views.table = {};
    var head = h("tr", {}, [
      h("th", { style: "width:26px" }, h("div", { class: "col-head" })),
      h("th", {}, h("div", { class: "col-head", text: t("servers") })),
      h("th", {}, h("div", { class: "col-head", text: t("fPlatform") })),
      h("th", {}, h("div", { class: "col-head", text: "CPU" })),
      h("th", {}, h("div", { class: "col-head", text: t("memory") })),
      h("th", {}, h("div", { class: "col-head", text: t("disk") })),
      h("th", {}, h("div", { class: "col-head", text: "↑ " + t("speed") })),
      h("th", {}, h("div", { class: "col-head", text: "↓ " + t("speed") })),
      h("th", {}, h("div", { class: "col-head", text: t("traffic") })),
      h("th", {}, h("div", { class: "col-head", text: "TCP" })),
      h("th", {}, h("div", { class: "col-head", text: t("fUptime") })),
    ]);
    var body = h("tbody");
    var table = h("table", { class: "listview" }, [h("thead", {}, head), body]);

    list.forEach(function (s) {
      var entry = tableRow(s);
      views.table[s.id] = entry;
      body.appendChild(entry.el);
    });
    return h("div", { class: "win table-scroll" }, table);
  }

  function tableRow(s) {
    var led = h("i", { class: "led" + (s.online ? " on" : "") });
    var cpuText = h("span", { class: "num" });
    var cpuFill = h("span", { class: "progress-fill" });
    var memText = h("span", { class: "num" });
    var memFill = h("span", { class: "progress-fill" });
    var diskText = h("span", { class: "num" });
    var diskFill = h("span", { class: "progress-fill" });
    var upSpeed = h("span", { class: "num" });
    var downSpeed = h("span", { class: "num" });
    var traffic = h("span", { class: "num" });
    var tcp = h("span", { class: "num" });
    var uptime = h("span");

    var el = h(
      "tr",
      {
        tabindex: "0",
        onclick: function (ev) {
          if (ev.target.tagName === "A") return;
          navigate("/server/" + s.id);
        },
        onkeydown: function (ev) {
          if (ev.key === "Enter") navigate("/server/" + s.id);
        },
      },
      [
        h("td", {}, [led]),
        h("td", {}, [
          h("span", { class: "cell-flex" }, [
            flagNode(s.country),
            h("a", { href: "/server/" + s.id, text: s.name }),
          ]),
        ]),
        h("td", {}, [
          h("span", { class: "cell-flex" }, [
            osIcon(s.platform),
            h("span", { text: s.platform + (s.arch ? " · " + s.arch : "") }),
          ]),
        ]),
        h("td", {}, [h("span", { class: "cell-meter" }, [cpuFill, cpuText])]),
        h("td", {}, [h("span", { class: "cell-meter" }, [memFill, memText])]),
        h("td", {}, [h("span", { class: "cell-meter" }, [diskFill, diskText])]),
        h("td", {}, [upSpeed]),
        h("td", {}, [downSpeed]),
        h("td", {}, [traffic]),
        h("td", {}, [tcp]),
        h("td", {}, [uptime]),
      ]
    );

    var entry = {
      el: el,
      led: led,
      cpuFill: cpuFill,
      cpuText: cpuText,
      memFill: memFill,
      memText: memText,
      diskFill: diskFill,
      diskText: diskText,
      upSpeed: upSpeed,
      downSpeed: downSpeed,
      traffic: traffic,
      tcp: tcp,
      uptime: uptime,
    };
    paintRow(entry, s);
    return entry;
  }

  function paintRow(entry, s) {
    entry.led.className = "led" + (s.online ? " on" : "");
    entry.el.className = s.online ? "" : "offline";
    setMeter(entry.cpuFill, entry.cpuText, s.cpu, percentText(s.cpu, 1));
    setMeter(entry.memFill, entry.memText, s.memPct, percentText(s.memPct, 1));
    setMeter(entry.diskFill, entry.diskText, s.diskPct, percentText(s.diskPct, 1));
    entry.upSpeed.textContent = speedText(s.upSpeed);
    entry.downSpeed.textContent = speedText(s.downSpeed);
    entry.traffic.textContent = byteText(s.upTransfer + s.downTransfer);
    entry.tcp.textContent = String(s.tcp);
    entry.uptime.textContent = durationShort(
      s.online ? s.uptime : (state.now - s.lastActive) / 1000
    );
  }

  function setMeter(fill, text, pct, label) {
    fill.style.width = clampPct(pct) + "%";
    fill.classList.toggle("hot", pct >= HOT_AT);
    text.textContent = label;
  }
  /* --- detail page (the original calls it the monitor page) -------------- */
  /* Layout follows the reference: a toolbar with [← back | monitor page], a
     second toolbar row with the time range and the sample count, the host
     sheet with three full-width meters at its foot, the four metric charts,
     and one full-width multi-line latency chart whose legend carries each
     probe's loss.                                                       */

  var CHART_SPECS = [
    { key: "cpu", metric: "cpu", title: "chartCpu", kind: "percent" },
    { key: "memory", metric: "memory", title: "chartMem", kind: "bytes" },
    { key: "net_in_speed", metric: "net_in_speed", title: "chartNet", kind: "speed" },
    { key: "load1", metric: "load1", title: "chartLoad", kind: "number" },
  ];

  function findServer(id) {
    return state.servers.filter(function (s) {
      return String(s.id) === String(id);
    })[0];
  }

  var PERIODS = [
    { id: "1d", key: "short1d" },
    { id: "7d", key: "short7d" },
    { id: "30d", key: "short30d" },
  ];

  function renderDetail(id) {
    var found = findServer(id);
    if (ui.titleText) ui.titleText.textContent = state.siteName || t("title");
    if (!found) {
      clear(ui.pageContent).appendChild(
        h("p", { class: "empty-state text-muted", text: t("noServers") })
      );
      ui.detail = null;
      return;
    }
    var s = decorate(found);

    var led = h("i", { class: "led" + (s.online ? " on" : "") });
    var statusText = h("span", {
      class: s.online ? "text-online" : "text-offline",
      text: s.online ? t("online") : s.everReported ? t("offline") : t("neverSeen"),
    });
    var statusDur = h("span", { class: "num" });
    var versionBadge = h("span", { class: "badge", hidden: !s.host.version, text: s.host.version || "" });

    var hostGrid = h("div", { class: "host-grid" });
    var wideMeters = {
      cpu: wideMeter(t("cpu")),
      mem: wideMeter(t("memory")),
      disk: wideMeter(t("disk")),
    };
    var hostBox = h("fieldset", { class: "groupbox" }, [
      h("legend", { text: t("host") }),
      h("div", { class: "host-head" }, [
        flagNode(s.country),
        h("h2", { class: "host-title", text: s.name }),
        h("span", { class: "host-status" }, [led, statusText, statusDur]),
        versionBadge,
      ]),
      hostGrid,
      wideMeters.cpu.el,
      wideMeters.mem.el,
      wideMeters.disk.el,
    ]);

    var charts = h("div", { class: "charts-grid" });
    var latencyValues = h("span", { class: "chart-values num" });
    var latencyCanvas = h("canvas");
    var latencyBox = h("fieldset", { class: "groupbox" }, [
      h("legend", { text: t("chartLatency") }),
      h("div", { class: "chart-box full" }, [
        h("div", { class: "chart-head" }, [
          h("span", { text: t("chartLatencySub") }),
          latencyValues,
        ]),
        h("div", { class: "graph graph-wide sunken" }, latencyCanvas),
      ]),
    ]);

    var periodButtons = h(
      "div",
      { class: "period-group", role: "group", "aria-label": t("period") },
      PERIODS.map(function (p) {
        return h("button", {
          class: "tool-btn" + (p.id === "1d" ? " active" : ""),
          type: "button",
          dataset: { period: p.id },
          "aria-pressed": p.id === "1d" ? "true" : "false",
          disabled: p.id !== "1d" && !state.isMember ? true : null,
          text: t(p.key),
          onclick: function () {
            setDetailPeriod(detail, p.id);
          },
        });
      })
    );

    var samplesLabel = h("span", { class: "tool-label text-muted num" });

    var toolbar = h("div", { class: "toolbar" }, [
      h("button", {
        class: "tool-btn",
        type: "button",
        onclick: function () {
          navigate("/");
        },
      }, [icon("back"), t("backList")]),
      h("div", { class: "tool-sep" }),
      h("span", { class: "tool-label text-muted", text: t("monitorPage") }),
    ]);
    var rangeBar = h("div", { class: "toolbar" }, [
      h("span", { class: "tool-label", text: t("period") }),
      h("div", { class: "tool-sep" }),
      periodButtons,
      h("div", { class: "tool-sep" }),
      samplesLabel,
    ]);

    clear(ui.pageContent).appendChild(
      h("div", { class: "panel" }, [toolbar, rangeBar, hostBox, chartsBox(charts), latencyBox])
    );

    var detail = {
      server: s,
      hostGrid: hostGrid,
      wideMeters: wideMeters,
      statusLed: led,
      statusText: statusText,
      statusDur: statusDur,
      versionBadge: versionBadge,
      charts: charts,
      charts_: {},
      latency: { canvas: latencyCanvas, values: latencyValues, probes: [], drawn: 0 },
      period: "1d",
      samplesLabel: samplesLabel,
    };
    ui.detail = detail;
    document.title = s.name + " - " + (state.siteName || t("title"));

    paintHostGrid(detail);
    paintWideMeters(detail);
    buildDetailCharts(detail);
    loadMetricsInto(detail);
    loadDetailProbes(detail);
  }

  function chartsBox(charts) {
    return h("fieldset", { class: "groupbox" }, [
      h("legend", { text: t("charts") }),
      charts,
    ]);
  }

  function setDetailPeriod(detail, period) {
    if (detail.period === period) return;
    detail.period = period;
    Array.prototype.forEach.call(detail.samplesLabel.parentNode.querySelectorAll("[data-period]"), function (btn) {
      var on = btn.dataset.period === period;
      btn.classList.toggle("active", on);
      btn.setAttribute("aria-pressed", on ? "true" : "false");
    });
    loadMetricsInto(detail);
    loadDetailProbes(detail);
  }

  function renderDetailValues() {
    var detail = ui.detail;
    if (!detail) return;
    var fresh = findServer(detail.server.id);
    if (!fresh) return;
    detail.server = decorate(fresh);
    paintHostGrid(detail);
    paintWideMeters(detail);
    // Charts are not redrawn per frame: a 2s refresh against a 30s sampling
    // interval would only shake the trace.
  }

  function wideMeter(label) {
    var fill = h("span", { class: "progress-fill" });
    var value = h("span", { class: "num" });
    return {
      el: h("div", { class: "wide-meter" }, [
        h("span", { class: "meter-label", text: label }),
        h("div", { class: "progress" }, fill),
        value,
      ]),
      set: function (text, pct, hot) {
        value.textContent = text;
        fill.style.width = clampPct(pct) + "%";
        fill.classList.toggle("hot", !!hot);
      },
    };
  }

  function paintWideMeters(detail) {
    var s = detail.server;
    detail.wideMeters.cpu.set(percentText(s.cpu, 1), s.cpu, s.cpu >= HOT_AT);
    detail.wideMeters.mem.set(byteText(s.state.mem_used), s.memPct, s.memPct >= HOT_AT);
    detail.wideMeters.disk.set(byteText(s.state.disk_used), s.diskPct, s.diskPct >= HOT_AT);
  }

  function priceTextOf(note) {
    if (!note.billing || note.billing.amount === "") return "";
    if (note.billing.amount === "0") return t("free");
    if (note.billing.amount === "-1") return t("usageBased");
    return note.billing.amount + " / " + t(cycleInfo(note.billing.cycle).key);
  }

  function paintHostGrid(detail) {
    var s = detail.server;
    var host = s.host;
    var st = s.state;
    var stateText = s.online
      ? t("online")
      : s.everReported
        ? t("offline")
        : t("neverSeen");
    detail.statusLed.className = "led" + (s.online ? " on" : "");
    detail.statusText.className = s.online ? "text-online" : "text-offline";
    detail.statusText.textContent = stateText;
    detail.statusDur.textContent =
      s.online
        ? " " + durationLong(s.uptime)
        : s.everReported
          ? " " + durationShort((state.now - s.lastActive) / 1000)
          : "";
    detail.versionBadge.hidden = !host.version;
    detail.versionBadge.textContent = host.version || "";

    var group = state.groups.filter(function (g) {
      return (g.servers || []).indexOf(s.id) >= 0;
    })[0];

    var note = s.note || {};
    var billing = s.billing;
    var price = priceTextOf(note);

    var rows = [
      [t("fPlatform"), host.platform || "—", host.platform ? osIcon(host.platform) : null],
      [t("fPlatformVersion"), host.platform_version || "—"],
      [t("fArch"), host.arch || "—"],
      [t("fVirtualization"), host.virtualization || "—"],
      [t("fCpu"), (host.cpu || []).join(", ") || "—"],
      [t("fMem"), byteText(host.mem_total) + " · " + percentText(s.memPct, 1)],
      [
        t("fSwap"),
        host.swap_total ? byteText(host.swap_total) + " · " + percentText(s.swapPct, 1) : "—",
      ],
      [t("fDisk"), byteText(host.disk_total) + " · " + percentText(s.diskPct, 1)],
      [t("fGpu"), (host.gpu || []).join(", ") || "—"],
      [t("fBootTime"), host.boot_time ? dateTimeText(host.boot_time * 1000) : "—"],
      [t("fLastActive"), dateTimeText(s.lastActive)],
      [t("fAgentVersion"), host.version || "—"],
      [t("fRegion"), s.country ? countryName(s.country) : "—"],
      [t("fGroup"), group ? group.name : "—"],
      ["TCP / UDP", s.tcp + " / " + s.udp],
      [
        t("load"),
        s.load1.toFixed(2) + " / " + s.load5.toFixed(2) + " / " + s.load15.toFixed(2),
      ],
    ];
    // The billing block, matching the reference's sheet: price, time left,
    // this cycle's spend and the lifetime counters.
    rows.push([t("price"), price || "—"]);
    if (billing && billing.forever) {
      rows.push([t("remaining"), "∞"]);
    } else if (billing && billing.days != null) {
      rows.push([
        t("remaining"),
        billing.expired
          ? t("expired") + " " + Math.abs(billing.days) + " " + t("forDays")
          : Math.abs(billing.days) + " " + t("forDays"),
      ]);
    }
    if (s.cycle && s.cycle.max) {
      rows.push([
        t("cycleTraffic"),
        byteText(s.cycle.transfer) + " / " + byteText(s.cycle.max),
      ]);
    }
    rows.push([t("totalTraffic"), "↓ " + byteText(s.downTransfer) + " · ↑ " + byteText(s.upTransfer)]);
    (st.temperatures || []).forEach(function (sensor) {
      rows.push([
        t("temperature") + (sensor.name ? " · " + sensor.name : ""),
        Number(sensor.temperature).toFixed(1) + " °C",
      ]);
    });
    if (note.plan) {
      if (note.plan.bandwidth) rows.push([t("bandwidth"), note.plan.bandwidth]);
      if (note.plan.trafficVol) rows.push([t("planTraffic"), note.plan.trafficVol]);
      if (note.plan.route) rows.push([t("route"), note.plan.route]);
      if (note.plan.ipv4 || note.plan.ipv6) {
        rows.push([t("ipv4v6"), [note.plan.ipv4, note.plan.ipv6].filter(Boolean).join(" · ")]);
      }
    }

    clear(detail.hostGrid);
    rows.forEach(function (pair) {
      detail.hostGrid.appendChild(
        h("dl", { class: "host-item" }, [
          h("dt", { text: pair[0] }),
          h("dd", null, [pair[2] || "", pair[1]]),
        ])
      );
    });

    if (detail.noteBox && detail.noteBox.parentNode) {
      detail.noteBox.parentNode.removeChild(detail.noteBox);
      detail.noteBox = null;
    }
    var extras = [];
    if (note.text) extras.push(h("p", { text: note.text }));
    if (note.orderLink) {
      extras.push(
        h("p", {}, [
          h("a", {
            href: note.orderLink,
            target: "_blank",
            rel: "noreferrer",
            text: t("renew") + (price ? " · " + price : ""),
          }),
        ])
      );
    }
    if (extras.length) {
      detail.noteBox = h("div", { class: "dialog-line" }, extras);
      detail.hostGrid.parentNode.appendChild(detail.noteBox);
    }
  }

  function buildDetailCharts(detail) {
    clear(detail.charts);
    detail.charts_ = {};
    CHART_SPECS.forEach(function (spec) {
      var canvas = h("canvas");
      var titleEl = h("span", { text: t(spec.title) });
      var head = h("div", { class: "chart-head" }, [
        titleEl,
        h("span", { class: "chart-values num", "data-role": "values" }),
      ]);
      if (spec.key === "net_in_speed") {
        head.insertBefore(
          h("span", { class: "chart-legend" }, [
            h("span", { class: "read-down", text: "▼ " }),
            h("span", { class: "read-text", text: t("netIn") + "  " }),
            h("span", { class: "read-up", text: "▲ " }),
            h("span", { class: "read-text", text: t("netOut") }),
          ]),
          head.lastChild
        );
      }
      detail.charts.appendChild(
        h("div", { class: "chart-box" }, [head, h("div", { class: "graph sunken" }, canvas)])
      );
      detail.charts_[spec.key] = {
        spec: spec,
        titleEl: titleEl,
        canvas: canvas,
        values: head.querySelector('[data-role="values"]'),
        points: [],
        second: null,
      };
    });
  }

  function loadMetricsInto(detail) {
    if (!state.tsdb) {
      Object.keys(detail.charts_).forEach(function (key) {
        detail.charts_[key].values.textContent = t("tsdbOff");
      });
      return;
    }
    CHART_SPECS.forEach(function (spec) {
      var slot = detail.charts_[spec.key];
      slot.serverMemTotal = Number((detail.server.host || {}).mem_total || 0);
      var base =
        API + "/server/" + detail.server.id + "/metrics?metric=" + spec.metric +
        "&period=" + detail.period;
      getJSON(base)
        .then(function (data) {
          slot.points = ((data && data.data_points) || []).map(function (p) {
            return { ts: Number(p.ts), value: Number(p.value) };
          });
          if (spec.key !== "net_in_speed") {
            slot.second = null;
            return null;
          }
          // The network chart carries both directions.
          return getJSON(
            API + "/server/" + detail.server.id + "/metrics?metric=net_out_speed&period=" +
              detail.period
          ).then(function (out) {
            slot.second = ((out && out.data_points) || []).map(function (p) {
              return { ts: Number(p.ts), value: Number(p.value) };
            });
          });
        })
        .catch(function () {
          slot.points = [];
          slot.second = null;
        })
        .then(function () {
          paintChart(slot);
        });
    });
  }

  function chartColors() {
    var cs = getComputedStyle(document.body);
    function read(name, fallback) {
      var value = cs.getPropertyValue(name).trim();
      return value || fallback;
    }
    return {
      bg: read("--graph-bg", "#000"),
      grid: read("--graph-grid", "#008040"),
      axis: read("--graph-axis", "#404040"),
      trace: read("--online", "#00b000"),
      second: read("--read-down", "#1d4ed8"),
      palette: [
        read("--online", "#00b000"),
        read("--read-down", "#1d4ed8"),
        read("--read-latency", "#b45309"),
        read("--read-loss", "#0f766e"),
        read("--accent-yellow", "#a06a00"),
        read("--offline", "#c00000"),
      ],
    };
  }

  function formatChartValue(kind, value) {
    if (kind === "percent") return percentText(value, 1);
    if (kind === "bytes") return byteText(value);
    if (kind === "speed") return speedText(value);
    return Number(value).toFixed(2);
  }

  // Draws one chart: black panel, green grid, one or two traces with a soft
  // fill under the first -- the reference's perf-monitor look.
  function paintChart(slot) {
    var canvas = slot.canvas;
    if (!canvas || !canvas.parentNode) return;
    var graph = canvas.parentNode;
    var w = graph.clientWidth - 4;
    var height = graph.clientHeight - 4;
    if (w <= 0 || height <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = height + "px";

    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    var colors = chartColors();
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, height);

    var series = [];
    if (slot.points && slot.points.length) series.push({ points: slot.points, color: colors.trace });
    if (slot.second && slot.second.length) series.push({ points: slot.second, color: colors.second });

    if (!series.length) {
      ctx.fillStyle = colors.axis;
      ctx.font = "11px Tahoma, SimSun, sans-serif";
      ctx.fillText(t("chartEmpty"), 8, height / 2);
      slot.values.textContent = t("chartEmpty");
      return;
    }

    var min = Infinity;
    var max = -Infinity;
    var minTs = Infinity;
    var maxTs = -Infinity;
    series.forEach(function (line) {
      line.points.forEach(function (p) {
        if (p.value < min) min = p.value;
        if (p.value > max) max = p.value;
        if (p.ts < minTs) minTs = p.ts;
        if (p.ts > maxTs) maxTs = p.ts;
      });
    });
    if (max === min) max = min + 1;
    if (min > 0) min = 0;
    if (maxTs === minTs) maxTs = minTs + 1;

    var pad = { l: 52, r: 6, t: 6, b: 14 };
    var plotW = Math.max(10, w - pad.l - pad.r);
    var plotH = Math.max(10, height - pad.t - pad.b);

    ctx.lineWidth = 1;
    ctx.font = "10px Tahoma, SimSun, sans-serif";
    for (var i = 0; i <= 4; i++) {
      var y = Math.round(pad.t + (plotH * i) / 4) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
      ctx.fillStyle = colors.axis;
      ctx.fillText(formatChartValue(slot.spec.kind, max - ((max - min) * i) / 4), 4, y + 3);
    }
    ctx.strokeStyle = colors.axis;
    for (var j = 0; j <= 4; j++) {
      var x = Math.round(pad.l + (plotW * j) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
    }

    function toPx(p) {
      return {
        x: pad.l + ((p.ts - minTs) / (maxTs - minTs)) * plotW,
        y: pad.t + plotH - ((p.value - min) / (max - min)) * plotH,
      };
    }

    series.forEach(function (line, index) {
      ctx.beginPath();
      line.points.forEach(function (p, k) {
        var pt = toPx(p);
        if (k === 0) ctx.moveTo(pt.x, pt.y);
        else ctx.lineTo(pt.x, pt.y);
      });
      ctx.strokeStyle = line.color;
      ctx.stroke();
      if (index === 0 && line.points.length > 1) {
        // Soft fill under the primary trace.
        ctx.lineTo(toPx(line.points[line.points.length - 1]).x, pad.t + plotH);
        ctx.lineTo(toPx(line.points[0]).x, pad.t + plotH);
        ctx.closePath();
        ctx.globalAlpha = 0.16;
        ctx.fillStyle = line.color;
        ctx.fill();
        ctx.globalAlpha = 1;
      }
    });

    ctx.fillStyle = colors.axis;
    ctx.fillText(timeText(minTs), pad.l, height - 2);
    var endLabel = timeText(maxTs);
    ctx.fillText(endLabel, pad.l + plotW - ctx.measureText(endLabel).width, height - 2);

    var values = slot.points;
    var sum = 0;
    var peak = 0;
    values.forEach(function (p) {
      sum += p.value;
      if (p.value > peak) peak = p.value;
    });
    var tail = values[values.length - 1].value;
    if (slot.spec.key === "memory" && slot.serverMemTotal) {
      slot.values.textContent =
        t("current") + " " + byteText(tail) + " / " + byteText(slot.serverMemTotal);
      return;
    }
    slot.values.textContent =
      t("current") + " " + formatChartValue(slot.spec.kind, tail) +
      "   " + t("avg") + " " + formatChartValue(slot.spec.kind, sum / values.length) +
      "   " + t("max") + " " + formatChartValue(slot.spec.kind, peak);
  }

  // The multi-line latency chart: one trace per probe over the window, the
  // legend naming each probe with its loss.
  function paintLatencyChart(detail) {
    var slot = detail.latency;
    var canvas = slot.canvas;
    if (!canvas || !canvas.parentNode) return;
    var graph = canvas.parentNode;
    var w = graph.clientWidth - 4;
    var height = graph.clientHeight - 4;
    if (w <= 0 || height <= 0) return;
    var dpr = window.devicePixelRatio || 1;
    canvas.width = Math.floor(w * dpr);
    canvas.height = Math.floor(height * dpr);
    canvas.style.width = w + "px";
    canvas.style.height = height + "px";

    var ctx = canvas.getContext("2d");
    ctx.scale(dpr, dpr);
    var colors = chartColors();
    ctx.fillStyle = colors.bg;
    ctx.fillRect(0, 0, w, height);

    var traces = slot.traces || [];
    if (!traces.length) {
      ctx.fillStyle = colors.axis;
      ctx.font = "11px Tahoma, SimSun, sans-serif";
      ctx.fillText(t("chartEmpty"), 8, height / 2);
      slot.values.textContent = t("chartEmpty");
      return;
    }

    var max = 0;
    var minTs = Infinity;
    var maxTs = -Infinity;
    var drawn = 0;
    traces.forEach(function (tr) {
      tr.points.forEach(function (p) {
        if (p.value > max) max = p.value;
        if (p.ts < minTs) minTs = p.ts;
        if (p.ts > maxTs) maxTs = p.ts;
      });
      drawn = Math.max(drawn, tr.drawn || tr.points.length);
    });
    if (!isFinite(minTs)) {
      slot.values.textContent = t("chartEmpty");
      return;
    }
    if (maxTs === minTs) maxTs = minTs + 1;
    max = Math.max(max, 10) * 1.1;

    var pad = { l: 52, r: 6, t: 6, b: 14 };
    var plotW = Math.max(10, w - pad.l - pad.r);
    var plotH = Math.max(10, height - pad.t - pad.b);

    ctx.lineWidth = 1;
    ctx.font = "10px Tahoma, SimSun, sans-serif";
    for (var i = 0; i <= 4; i++) {
      var y = Math.round(pad.t + (plotH * i) / 4) + 0.5;
      ctx.strokeStyle = colors.grid;
      ctx.beginPath();
      ctx.moveTo(pad.l, y);
      ctx.lineTo(pad.l + plotW, y);
      ctx.stroke();
      ctx.fillStyle = colors.axis;
      ctx.fillText(Math.round(max - (max * i) / 4) + "ms", 4, y + 3);
    }
    ctx.strokeStyle = colors.axis;
    for (var j = 0; j <= 4; j++) {
      var x = Math.round(pad.l + (plotW * j) / 4) + 0.5;
      ctx.beginPath();
      ctx.moveTo(x, pad.t);
      ctx.lineTo(x, pad.t + plotH);
      ctx.stroke();
    }

    traces.forEach(function (tr) {
      ctx.strokeStyle = tr.color;
      ctx.beginPath();
      var pen = false;
      tr.points.forEach(function (p) {
        if (p.value <= 0) {
          // A failed sample is a gap, not a dip to the floor.
          pen = false;
          return;
        }
        var px = pad.l + ((p.ts - minTs) / (maxTs - minTs)) * plotW;
        var py = pad.t + plotH - (p.value / max) * plotH;
        if (!pen) {
          ctx.moveTo(px, py);
          pen = true;
        } else ctx.lineTo(px, py);
      });
      ctx.stroke();
    });

    ctx.fillStyle = colors.axis;
    ctx.fillText(timeText(minTs), pad.l, height - 2);
    var endLabel = timeText(maxTs);
    ctx.fillText(endLabel, pad.l + plotW - ctx.measureText(endLabel).width, height - 2);

    // Legend: one entry per probe with its loss over the window.
    clear(slot.values);
    traces.forEach(function (tr, idx) {
      slot.values.appendChild(
        h("span", { class: "chart-value-item" }, [
          h("span", { class: "legend-dot", style: "background:" + tr.color }),
          tr.name +
            (tr.loss > 0 ? " " + t("loss") + " " + tr.loss.toFixed(1) + "%" : ""),
          idx < traces.length - 1 ? " · " : "",
        ])
      );
    });
    if (detail.samplesLabel) {
      detail.samplesLabel.textContent = t("samples", { n: drawn });
    }
  }

  function loadDetailProbes(detail) {
    getJSON(API + "/server/" + detail.server.id + "/service?period=" + detail.period)
      .then(function (list) {
        detail.latency.probes = list || [];
      })
      .catch(function () {
        detail.latency.probes = [];
      })
      .then(function () {
        buildLatencyTraces(detail);
      });
  }

  function buildLatencyTraces(detail) {
    var infos = detail.latency.probes;
    var colors = chartColors().palette;
    var traces = infos.map(function (info, idx) {
      var raw = (info.created_at || []).map(function (ts, i) {
        return { ts: Number(ts), value: Number(info.avg_delay[i] || 0) };
      });
      var buckets = downsampleSeries(raw, 360);
      var stats = state.services[info.monitor_id] || {};
      return {
        name: info.monitor_name || String(info.monitor_id),
        color: colors[idx % colors.length],
        points: buckets.points,
        drawn: buckets.count,
        loss: dayDownRate(stats),
      };
    });
    detail.latency.traces = traces;
    paintLatencyChart(detail);
  }

  // Average a raw series into at most `max` buckets; returns the bucketed
  // points plus how many buckets it made, for the sample-count label.
  function downsampleSeries(raw, max) {
    if (!raw.length) return { points: [], count: 0 };
    var step = Math.max(1, Math.ceil(raw.length / max));
    var points = [];
    for (var i = 0; i < raw.length; i += step) {
      var sum = 0;
      var n = 0;
      var end = Math.min(raw.length, i + step);
      for (var j = i; j < end; j++) {
        sum += raw[j].value;
        n++;
      }
      points.push({ ts: raw[Math.floor((i + end - 1) / 2)].ts, value: n ? sum / n : 0 });
    }
    return { points: points, count: points.length };
  }

  function redrawCharts() {
    if (!ui.detail) return;
    Object.keys(ui.detail.charts_).forEach(function (key) {
      paintChart(ui.detail.charts_[key]);
    });
    paintLatencyChart(ui.detail);
  }

  /* --- router ----------------------------------------------------------- */

  function navigate(path, replace) {
    if (replace) history.replaceState({}, "", path);
    else history.pushState({}, "", path);
    route();
  }

  function route() {
    var match = /^\/server\/(\d+)\/?$/.exec(location.pathname);
    clear(ui.pageContent);
    // The view switcher belongs to the fleet list; a detail page has its own
    // toolbar, so the app one would only offer buttons that do nothing.
    if (ui.toolbar) ui.toolbar.hidden = !!match;
    if (match) {
      state.route = { name: "detail", id: Number(match[1]) };
      renderDetail(match[1]);
    } else {
      state.route = { name: "list", id: 0 };
      document.title = state.siteName || t("title");
      ui.pageContent.appendChild(ui.filterBar);
      ui.pageContent.appendChild(ui.summary);
      ui.pageContent.appendChild(ui.listPane);
      if (state.customCode) ui.pageContent.appendChild(ui.customCode);
      views = { card: {}, ring: {}, table: {} };
      renderList();
      paintSummary();
      paintFilters();
    }
    paintStatus();
    window.scrollTo(0, 0);
  }

  /* --- boot ------------------------------------------------------------- */

  function boot() {
    loadStoredNotes();
    try {
      var storedView = localStorage.getItem(VIEW_KEY);
      if (storedView === "card" || storedView === "ring" || storedView === "table") {
        state.view = storedView;
      }
    } catch (e) {
      /* ignore */
    }

    Promise.all([
      loadSetting(),
      loadMember(),
      loadGroups(),
      loadServices(),
      loadServiceServers(),
    ]).then(function () {
      buildShell();
      route();
      connect();
      setInterval(function () {
        if (!state.connected) return;
        loadServices().then(update);
      }, SERVICE_REFRESH_MS);
      var media = matchMedia("(prefers-color-scheme: dark)");
      if (media.addEventListener) {
        media.addEventListener("change", function () {
          if (storedScheme() === "auto") applyScheme("auto");
        });
      }
    });

    // Whole-card links are real anchors for middle-click and "open in new
    // tab"; plain left clicks stay inside the SPA.
    document.addEventListener("click", function (ev) {
      if (ev.defaultPrevented || ev.button !== 0 || ev.metaKey || ev.ctrlKey || ev.shiftKey || ev.altKey) return;
      var target = ev.target;
      if (!target || !target.closest) return;
      var a = target.closest("a[href^='/']");
      if (!a || a.target === "_blank" || /^\/dashboard/.test(a.getAttribute("href"))) return;
      ev.preventDefault();
      navigate(a.getAttribute("href"));
    });
    window.addEventListener("popstate", route);
    window.addEventListener("resize", function () {
      if (ui.resizeTimer) clearTimeout(ui.resizeTimer);
      ui.resizeTimer = setTimeout(redrawCharts, 200);
    });
    document.addEventListener("visibilitychange", function () {
      if (
        document.visibilityState === "visible" &&
        socket &&
        socket.readyState > WebSocket.OPEN
      ) {
        reconnectDelay = 1000;
        connect();
      }
    });
  }

  boot();
})();
