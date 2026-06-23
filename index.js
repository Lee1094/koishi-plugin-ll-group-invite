const { Schema } = require('koishi')
const fs = require('fs')
const path = require('path')

const WHITELIST_FILE = path.join(__dirname, 'whitelist.json')

function loadWhitelist() {
  try {
    if (fs.existsSync(WHITELIST_FILE)) {
      return JSON.parse(fs.readFileSync(WHITELIST_FILE, 'utf-8'))
    }
  } catch {}
  return []
}

function saveWhitelist(list) {
  fs.writeFileSync(WHITELIST_FILE, JSON.stringify(list, null, 2), 'utf-8')
}

const Config = Schema.object({
  admins: Schema.array(Schema.string())
    .default([])
    .description('管理员QQ号，允许增删白名单'),
  logChannel: Schema.string()
    .default('')
    .description('日志推送频道ID（可选，用于记录邀请通过/拒绝）'),
})

function apply(ctx, config) {
  let whitelist = loadWhitelist()

  function syncWhitelist() {
    saveWhitelist(whitelist)
  }

  function isAdmin(userId) {
    if (!config.admins || config.admins.length === 0) return true
    return config.admins.includes(String(userId))
  }

  // ===== 群邀请自动处理 =====
  const handleInvite = async (session) => {
    const inviterId = String(session.userId || session.operatorId || '')
    const groupId = String(session.guildId || session.groupId || '')
    const flag = session.messageId || session.requestId || ''

    ctx.logger.info(`[群邀请] 收到: inviter=${inviterId}, group=${groupId}, flag=${flag}`)

    if (!inviterId || inviterId === 'undefined') {
      ctx.logger.warn(`[群邀请] 无法获取邀请人ID, session: ${JSON.stringify(session)}`)
      return
    }

    // 管理员 或 白名单内用户 允许邀请
    const allowed = isAdmin(inviterId) || whitelist.includes(inviterId)
    if (!allowed) {
      ctx.logger.info(`[群邀请] 拒绝: ${inviterId}（非管理员/不在白名单）`)
      logToChannel(`⛔ ${inviterId} 邀请入群 ${groupId} 已拒绝`)
      return
    }

    // 尝试多种 API / flag 格式
    const flagParts = flag.split('|')
    const methods = [
      // 方法 1: Koishi 标准
      async () => {
        ctx.logger.info('[群邀请] 尝试 handleGuildRequest')
        await session.bot.handleGuildRequest(flag, true)
      },
      // 方法 2: 只用 flag 第二段（纯请求 ID）
      async () => {
        if (!flagParts[1]) throw new Error('flag 格式不对')
        ctx.logger.info(`[群邀请] 尝试 set_group_add_request flag=${flagParts[1]}`)
        const bot = session.bot.internal || session.bot
        const api = bot.set_group_add_request || bot.setGroupAddRequest
        if (!api) throw new Error('set_group_add_request 不可用')
        await api.call(bot, flagParts[1], 'invite', true, '')
      },
      // 方法 3: 直接用 session.bot 的 request 方法
      async () => {
        ctx.logger.info('[群邀请] 尝试 bot.request set_group_add_request')
        await session.bot.request('set_group_add_request', { flag: flagParts[1] || flag, sub_type: 'invite', approve: true })
      },
    ]

    for (const fn of methods) {
      try {
        await fn()
        ctx.logger.info(`[白名单通过] ${inviterId} 邀请入群 ${groupId}${isAdmin(inviterId) ? '(管理员)' : ''}`)
        logToChannel(`✅ ${inviterId} 邀请入群 ${groupId} 已自动通过`)
        return
      } catch (e) {
        ctx.logger.warn(`[群邀请] 尝试失败: ${e.message}`)
      }
    }

    ctx.logger.error(`[群邀请] 所有方法均失败`)
    logToChannel(`❌ ${inviterId} 邀请入群 ${groupId} 通过失败（API 不兼容）`)
  }

  function logToChannel(msg) {
    if (config.logChannel) {
      // 需要获取 bot 实例来发消息，用第一个可用 bot
      for (const bot of ctx.bots) {
        bot.sendMessage(config.logChannel, msg).catch(() => {})
        break
      }
    }
  }

  // 标准 Koishi 事件
  ctx.on('guild-request', handleInvite)

  // 兼容：某些 OneBot 适配器用不同的事件名
  ctx.on('guild-member-request', (session) => {
    ctx.logger.info(`[群邀请] guild-member-request 事件: ${JSON.stringify(session)}`)
  })

  // 日志：打印 bot 内部可用方法（调试用）
  if (ctx.bots && ctx.bots.length > 0) {
    const bot = ctx.bots[0]
    const internal = bot.internal
    if (internal) {
      const methods = Object.keys(internal).filter(k => typeof internal[k] === 'function')
      ctx.logger.info(`[群邀请] bot.internal 方法: ${methods.join(', ')}`)
    }
  }

  // ===== 管理命令 =====
  ctx.command('invitelist', '查看群邀请白名单（管理员始终可邀请）')
    .action(() => {
      if (whitelist.length === 0) return '白名单为空（管理员始终可邀请）'
      return `当前白名单（${whitelist.length}人，管理员始终可邀请）：\n${whitelist.join('\n')}`
    })

  ctx.command('invitelist.add <qq:string>', '添加群邀请白名单')
    .action(({ session }, qq) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      qq = qq.trim()
      if (!/^\d{5,12}$/.test(qq)) return 'QQ号格式错误'
      if (whitelist.includes(qq)) return `${qq} 已在白名单中`
      whitelist.push(qq)
      syncWhitelist()
      return `✅ ${qq} 已添加到白名单`
    })

  ctx.command('invitelist.remove <qq:string>', '移除群邀请白名单')
    .action(({ session }, qq) => {
      if (!isAdmin(String(session.userId))) return '权限不足'
      qq = qq.trim()
      const idx = whitelist.indexOf(qq)
      if (idx === -1) return `${qq} 不在白名单中`
      whitelist.splice(idx, 1)
      syncWhitelist()
      return `✅ ${qq} 已从白名单移除`
    })
}

module.exports = { Config, apply }
