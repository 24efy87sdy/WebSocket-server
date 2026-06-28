// 联机服务器配置文件
// 所有选项均有默认值，可按需修改

module.exports = {
  // 服务器监听端口
  port: 3000,

  // 全局最大同时连接客户端数
  maxClients: 2026,

  // 是否启用控制台日志输出
  enableLog: true,

  // 是否启用房间功能（关闭后所有消息全服广播，join/leave 指令无效）
  enableRooms: true,

  // 握手消息配置（连接成功后服务器主动发送的第一条消息）
  handshake: {
    enable: true,              // 是否发送握手消息
    autoAssignPlayerId: true,  // 是否自动生成并分配玩家 ID
    welcomeText: "欢迎来到TurboWarp联机服务器",
    serverVersion: "1.2.0",
  },

  // 房间相关设置
  room: {
    maxPlayers: 2,   // 默认单房间最大人数（创建房间时可被指令覆盖）
  },

  // 加入房间行为
  roomJoin: {
    enableReply: true,   // 是否向加入者发送加入成功回执
    indexType: "current", // 玩家序号分配方式："current"（当前人数序号）或 "cumulative"（累计加入序号）
    broadcastJoin: true, // 是否在玩家加入房间时通知房间内其他玩家
  },

  // 离开房间行为
  roomLeave: {
    enableNotify: true,  // 是否向房间内其他玩家广播离开通知
    enableReindex: true, // 是否在有人离开后重新排列剩余玩家序号（仅在 indexType 为 current 时生效）
  },

  // 消息广播行为
  broadcast: {
    echoBack: false,      // 是否将广播消息回显给发送者本人
  },

  // 心跳检测（防止僵尸连接）
  heartbeat: {
    enable: true,         // 是否启用心跳
    interval: 30000,      // 心跳间隔（毫秒），建议不低于 10000
  },

  // 单个消息最大长度（字节），超过将被拒绝
  maxMessageSize: 40960,

  // 同一 IP 最大连接数（防止单 IP 恶意占用资源）
  maxConnectionsPerIP: 3,

  // 客户端消息速率限制（防刷屏）
  rateLimit: {
    enable: true,              // 是否启用速率限制
    maxMessagesPerSecond: 90,  // 每秒最多允许的消息数
  },
};