import type { HostOpsProcess } from '../../data/hostOps';

export interface HostGuideEntry {
  /** 4-10 字极短中文标签（仅名称旁/副行展示）。 */
  shortLabel: string;
  /** 一句话用途（仅在进程详情抽屉展示）。 */
  purpose: string;
  /** 一句话精简建议（仅在进程详情抽屉展示）。 */
  advice: string;
  /** 属于 Agent §4.1 保守可精简白名单时填写对应 unit，方便抽屉直达「可精简系统服务」。 */
  slimUnit?: string;
}

/**
 * Ubuntu / Debian / 云镜像常见进程与服务静态中文知识库（纯前端，零后端开销）。
 * key 全部小写，按进程名 / 脚本 basename 或 systemd unit 匹配。
 */
export const HOST_GUIDE: Record<string, HostGuideEntry> = {
  // ---- §4.1 Agent 保守白名单（12 项可停用） ----
  modemmanager: {
    shortLabel: '拨号与蜂窝猫管理',
    purpose: '管理物理串口蜂窝调制解调器与移动宽带设备。',
    advice: '云服务器无蜂窝硬件，停用可省出常驻内存且可随时恢复。',
    slimUnit: 'ModemManager.service',
  },
  udisksd: {
    shortLabel: '桌面磁盘热插拔管理',
    purpose: '为桌面环境提供 U 盘/移动硬盘自动识别与挂载服务。',
    advice: '服务器静态磁盘挂载不依赖它，可从服务列表安全停用。',
    slimUnit: 'udisks2.service',
  },
  udisks2: {
    shortLabel: '桌面磁盘热插拔管理',
    purpose: '为桌面环境提供 U 盘/移动硬盘自动识别与挂载服务。',
    advice: '服务器静态磁盘挂载不依赖它，可从服务列表安全停用。',
    slimUnit: 'udisks2.service',
  },
  packagekitd: {
    shortLabel: '图形化软件包服务',
    purpose: '为桌面软件中心提供包查询与更新抽象层。',
    advice: '命令行 apt 与面板不依赖它，停用不影响系统更新。',
    slimUnit: 'packagekit.service',
  },
  packagekit: {
    shortLabel: '图形化软件包服务',
    purpose: '为桌面软件中心提供包查询与更新抽象层。',
    advice: '命令行 apt 与面板不依赖它，停用不影响系统更新。',
    slimUnit: 'packagekit.service',
  },
  fwupd: {
    shortLabel: '硬件固件升级守护',
    purpose: '检测并更新主板、NVMe、外设等物理设备固件。',
    advice: '云虚拟机无法直刷底层硬件固件，可安全停用。',
    slimUnit: 'fwupd.service',
  },
  apport: {
    shortLabel: 'Ubuntu 崩溃报告采集',
    purpose: '在程序崩溃时收集转储信息并准备上报。',
    advice: '纯上报用途，可安全停用并用 journald 查看故障日志。',
    slimUnit: 'apport.service',
  },
  whoopsie: {
    shortLabel: '崩溃报告上传服务',
    purpose: '将 apport 收集的崩溃数据上传至 Canonical 服务器。',
    advice: '纯错误上报组件，可从服务列表安全停用。',
    slimUnit: 'whoopsie.service',
  },
  'motd-news': {
    shortLabel: '登录欢迎语新闻拉取',
    purpose: '定时拉取 Ubuntu 官方公告并展示在 SSH 欢迎语里。',
    advice: '仅影响登录提示文本，可安全停用。',
    slimUnit: 'motd-news.timer',
  },
  'accounts-daemon': {
    shortLabel: '桌面登录账户信息服务',
    purpose: '为图形登录界面提供本地用户头像与信息查询。',
    advice: '无桌面环境的云 VM 不需要，可安全停用。',
    slimUnit: 'accounts-daemon.service',
  },
  'avahi-daemon': {
    shortLabel: '局域网 mDNS 设备发现',
    purpose: '通过 mDNS/DNS-SD 广播并发现同局域网主机与服务。',
    advice: '云服务器通常无需局域网零配置发现，可安全停用。',
    slimUnit: 'avahi-daemon.service',
  },
  avahi: {
    shortLabel: '局域网 mDNS 设备发现',
    purpose: '通过 mDNS/DNS-SD 广播并发现同局域网主机与服务。',
    advice: '云服务器通常无需局域网零配置发现，可安全停用。',
    slimUnit: 'avahi-daemon.service',
  },
  cupsd: {
    shortLabel: '打印队列后台服务',
    purpose: '管理本地与网络打印机的打印队列与驱动。',
    advice: '云主机通常无打印需求，可安全停用。',
    slimUnit: 'cups.service',
  },
  cups: {
    shortLabel: '打印队列后台服务',
    purpose: '管理本地与网络打印机的打印队列与驱动。',
    advice: '云主机通常无打印需求，可安全停用。',
    slimUnit: 'cups.service',
  },
  bluetoothd: {
    shortLabel: '蓝牙设备协议栈服务',
    purpose: '管理物理蓝牙适配器与配对设备连接。',
    advice: '云虚拟机无蓝牙硬件，可从服务列表安全停用。',
    slimUnit: 'bluetooth.service',
  },
  bluetooth: {
    shortLabel: '蓝牙设备协议栈服务',
    purpose: '管理物理蓝牙适配器与配对设备连接。',
    advice: '云虚拟机无蓝牙硬件，可从服务列表安全停用。',
    slimUnit: 'bluetooth.service',
  },
  snapd: {
    shortLabel: 'Snap 容器化包管理',
    purpose: '运行并自动更新 Canonical Snap 格式软件包。',
    advice: '仅当未安装任何 snap 应用（如云厂商代理）时才建议停用。',
    slimUnit: 'snapd.service',
  },

  // ---- 核心与系统运行链（仅供识别，不可停用） ----
  systemd: {
    shortLabel: '系统初始化与服务总控',
    purpose: 'Linux 1 号进程，负责启动并托管全机全部服务与单元。',
    advice: '系统核心进程，严禁关闭。',
  },
  'systemd-journald': {
    shortLabel: '系统与内核日志守护',
    purpose: '统一收集内核与全部 systemd 服务日志。',
    advice: '建议保留；可在「优化」分段清理历史日志并限制上限为 100M。',
  },
  'systemd-udevd': {
    shortLabel: '内核设备与网卡命名管理',
    purpose: '监听内核设备热插拔并维护 /dev 节点及网卡名规则。',
    advice: '系统底层核心守护进程，不可停用。',
  },
  'systemd-logind': {
    shortLabel: '用户登录会话管理',
    purpose: '管理 SSH 登录会话、终端权限及托管应用 user unit 生命周期。',
    advice: '托管应用与登录会话依赖该服务，不可停用。',
  },
  'systemd-networkd': {
    shortLabel: '系统网络接口配置守护',
    purpose: '依据 netplan/networkd 配置管理主机网卡与路由。',
    advice: '断网风险极高，严禁停用。',
  },
  'systemd-resolved': {
    shortLabel: '本机 DNS 解析缓存服务',
    purpose: '提供 127.0.0.53 本地 DNS 解析与缓存转发。',
    advice: '系统域名解析依赖该服务，不建议停用。',
  },
  'systemd-timesyncd': {
    shortLabel: '系统轻量 NTP 时间同步',
    purpose: '保持系统时钟精准同步，确保 TLS 证书与 HMAC 签名校验通过。',
    advice: '时间偏差会导致面板鉴权失败，应保持运行。',
  },
  chronyd: {
    shortLabel: '高精度 NTP 时间同步',
    purpose: '通过 NTP 校准系统时间与硬件时钟漂移。',
    advice: '面板安全鉴权与证书校验依赖准确时间，建议保留。',
  },
  'dbus-daemon': {
    shortLabel: '系统进程间消息总线',
    purpose: '承接 systemd 与各系统守护进程之间的 IPC 通信。',
    advice: '系统核心基础设施，停用会导致 systemctl 等工具失灵。',
  },
  sshd: {
    shortLabel: 'OpenSSH 远程登录服务',
    purpose: '监听 SSH 端口处理远程终端与密钥认证连接。',
    advice: '远程运维核心入口，不可停用（可配合防火墙切换白名单模式）。',
  },
  polkitd: {
    shortLabel: '系统权限授权代理',
    purpose: '裁决非特权进程向系统服务发起的特权调用请求。',
    advice: '系统基础组件，建议保留。',
  },
  cron: {
    shortLabel: '系统定时任务调度器',
    purpose: '按计划执行 /etc/cron.d 与用户 crontab 中的周期任务。',
    advice: '面板「定时任务」分段与系统维护脚本依赖它，建议保留。',
  },
  rsyslogd: {
    shortLabel: '传统文本 syslog 日志服务',
    purpose: '把系统日志同步写入 /var/log/syslog 等文本文件。',
    advice: '部分运维工具读取 /var/log/auth.log 等文本，建议保留。',
  },
  agetty: {
    shortLabel: '本地控制台登录终端',
    purpose: '在云厂商 VNC 控制台及 tty 上提供登录提示。',
    advice: 'VNC 救援登录依赖此进程，建议保留。',
  },
  multipathd: {
    shortLabel: '多路径块存储守护',
    purpose: '为多路径 SAN/iSCSI/云块存储维护冗余 I/O 路径。',
    advice: '部分云厂商磁盘挂载链依赖它，不应贸然关闭。',
  },
  iscsid: {
    shortLabel: 'iSCSI 块存储客户端',
    purpose: '维持云主机挂载远程 iSCSI 卷的连接会话。',
    advice: 'Oracle 等云厂商云盘依赖 iSCSI 会话，不可关闭。',
  },
  'unattended-upgrades': {
    shortLabel: '系统安全更新后台服务',
    purpose: '按计划在后台自动安装高危安全补丁。',
    advice: '若低内存机器偶发 OOM，建议优先开启「优化」中的 2G Swap。',
  },
  'unattended-upgrade-shutdown': {
    shortLabel: '安全更新关机收尾等待',
    purpose: '保证系统重启或关机时不打断正在进行的 apt 安全更新。',
    advice: '系统安全更新配套组件，建议保留。',
  },
  'networkd-dispatcher': {
    shortLabel: '网络状态变更脚本触发器',
    purpose: '在网卡启动或切换状态时执行对应的网络钩子脚本。',
    advice: '与 systemd-networkd 联动，建议保留。',
  },
  irqbalance: {
    shortLabel: '多核中断负载均衡',
    purpose: '将网卡等硬件中断分散到多个 CPU 核心处理。',
    advice: '开销极微，多核 VM 建议保留；单核下几乎不占资源。',
  },
  acpid: {
    shortLabel: '电源与控制台关机事件监听',
    purpose: '接收云平台控制台发出的软关机（ACPI）按钮事件。',
    advice: '云面板正常关机依赖此服务，建议保留。',
  },
  'cloud-init': {
    shortLabel: '云镜像首启/开机初始化',
    purpose: '在虚拟机开机阶段下发网卡配置、主机名与控制台 SSH 公钥。',
    advice: '部分云商每次重启都会运行，不建议手动关闭。',
  },
  'qemu-ga': {
    shortLabel: 'QEMU/KVM 宿主机通信代理',
    purpose: '配合 KVM 云平台实现重置密码、快照冻结文件系统与监控上报。',
    advice: '云控制台重置密码与热快照依赖它，建议保留。',
  },
  'oracle-cloud-agent': {
    shortLabel: 'Oracle 云运维插件代理',
    purpose: '为 OCI 云平台提供控制台巡检与实例元数据管理通道。',
    advice: '属于厂商云代理组件，请确认无需控制台集成后再调整。',
  },
  'amazon-ssm-agent': {
    shortLabel: 'AWS Systems Manager 代理',
    purpose: '支撑 AWS Session Manager 免 SSH 登录与控制台运维。',
    advice: '依赖 AWS 控制台会话功能时应保留。',
  },
  google_guest_agent: {
    shortLabel: 'GCP 云实例来宾代理',
    purpose: '同步 Google Cloud OS Login 密钥、路由与元数据。',
    advice: 'GCP 实例控制台 SSH 依赖它，不建议停用。',
  },
  walinuxagent: {
    shortLabel: 'Azure Linux 宿主机代理',
    purpose: '与 Azure 控制台通信处理网络初始化与磁盘挂载事件。',
    advice: 'Azure VM 核心协同代理，建议保留。',
  },
  'aliyun-service': {
    shortLabel: '阿里云云助手客户端',
    purpose: '支撑阿里云控制台在线命令与实例监控功能。',
    advice: '如需通过阿里云控制台运维请保留。',
  },
  rpcbind: {
    shortLabel: 'RPC 端口映射守护',
    purpose: '将 NFS/RPC 服务程序号映射为网络端口号。',
    advice: '如未使用 NFS 网络挂载通常可留置观察，占用极低。',
  },

  // ---- KHC 面板受管组件与常见应用 ----
  'khc-agent': {
    shortLabel: '面板节点 Agent 守护',
    purpose: '响应控制面按需指令，下发站点/转发/证书与主机运维任务。',
    advice: '控制面唯一节点通道，请保持在线运行。',
  },
  caddy: {
    shortLabel: 'Caddy 反向代理与 HTTPS',
    purpose: '托管全部反代站点并自动申请/续期 ACME TLS 证书。',
    advice: '对外应用统一入口服务，如需纯看状态可到「应用」页管理。',
  },
  'sing-box': {
    shortLabel: 'sing-box 代理核心',
    purpose: '运行面板部署的多协议（TUIC/Hysteria2 等）代理节点实例。',
    advice: '托管应用核心进程，可在「应用」页查看详情、重启或调整配置。',
  },
  cloudflared: {
    shortLabel: 'Cloudflare Tunnel 守护',
    purpose: '建立出站加密隧道将面板或站点安全暴露给 Cloudflare 边缘。',
    advice: '隧道接入节点的核心通道进程，应保持运行。',
  },
  socat: {
    shortLabel: 'TCP/UDP 端口转发进程',
    purpose: '承载面板「端口转发」规则对应的单端口转发进程。',
    advice: '可在「网络 → 端口转发」卡片按规则启用、停用或删除。',
  },
  node_exporter: {
    shortLabel: 'Prometheus 主机指标采集',
    purpose: '以 HTTP 端点暴露本机 CPU、内存与磁盘运行指标。',
    advice: '可在「节点设置 → 组件」查看与启停配置。',
  },
  dockerd: {
    shortLabel: 'Docker 容器引擎守护',
    purpose: '管理本机 Docker 容器生命周期与镜像存储网络。',
    advice: '若低内存机器无需运行容器，请注意定期清理无用镜像防爆盘。',
  },
  containerd: {
    shortLabel: '容器运行时守护进程',
    purpose: '负责底层容器镜像拉取与进程隔离运行（Docker/K8s 底座）。',
    advice: '与 Docker 引擎配套使用，有运行容器时不可停用。',
  },
};

function normalizeLookupKey(raw: string): string {
  return raw
    .trim()
    .toLowerCase()
    .replace(/^.*\//, '')
    .replace(/^\((.+)\)$/, '$1')
    .replace(/:$/, '')
    .replace(/\.(service|socket|timer|path)$/, '');
}

/** 根据进程名与命令行查找静态中文说明（纯前端查表）。 */
export function lookupProcessGuide(process: Pick<HostOpsProcess, 'name' | 'cmdline'>): HostGuideEntry | null {
  const candidates: string[] = [process.name];
  const tokens = process.cmdline.trim().split(/\s+/).filter(Boolean);
  for (const token of tokens.slice(0, 4)) {
    if (!token.startsWith('-')) candidates.push(token);
  }
  for (const raw of candidates) {
    const key = normalizeLookupKey(raw);
    if (key && HOST_GUIDE[key]) return HOST_GUIDE[key];
    // 处理形如 "khc-agent" 脚本路径或 "(sd-pam)" / 版本后缀匹配
    if (key.startsWith('python') || key.startsWith('node')) continue;
    const withoutDashSuffix = key.replace(/-bin$/, '');
    if (withoutDashSuffix !== key && HOST_GUIDE[withoutDashSuffix]) {
      return HOST_GUIDE[withoutDashSuffix];
    }
  }
  // 专项关键字兜底（如 python3 /opt/khc-agent/agent.py）
  const cmdLower = process.cmdline.toLowerCase();
  if (cmdLower.includes('/opt/khc-agent/')) return HOST_GUIDE['khc-agent'] ?? null;
  if (cmdLower.includes('networkd-dispatcher')) return HOST_GUIDE['networkd-dispatcher'] ?? null;
  if (cmdLower.includes('unattended-upgrade')) return HOST_GUIDE['unattended-upgrades'] ?? null;
  return null;
}

/** 根据可精简白名单 id 或 unit 名查找中文短标。 */
export function lookupSlimServiceGuide(idOrUnit: string): HostGuideEntry | null {
  const key = normalizeLookupKey(idOrUnit);
  if (key && HOST_GUIDE[key]) return HOST_GUIDE[key];
  return null;
}
