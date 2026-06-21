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
  ctx.on('guild-member-request', async (session) => {
    if (session.subtype !== 'invite') return

    const inviterId = String(session.userId)

    if (whitelist.includes(inviterId)) {
      try {
        await session.bot.handleGuildMemberRequest(
          session.messageId,
          session.guildId,
          session.userId,
          true
        )
        ctx.logger.info(`[白名单通过] ${inviterId} 邀请入群 ${session.guildId}`)
        if (config.logChannel) {
          session.bot.sendMessage(config.logChannel,
            `✅ ${inviterId} 邀请入群 ${session.guildId} 已自动通过`
          ).catch(() => {})
        }
      } catch (e) {
        ctx.logger.error(`自动通过失败: ${e.message}`)
        if (config.logChannel) {
          session.bot.sendMessage(config.logChannel,
            `❌ ${inviterId} 邀请入群 ${session.guildId} 通过失败: ${e.message}`
          ).catch(() => {})
        }
      }
    } else {
      ctx.logger.info(`[白名单拒绝] ${inviterId} 邀请入群 ${session.guildId}（不在白名单）`)
      if (config.logChannel) {
        session.bot.sendMessage(config.logChannel,
          `⛔ ${inviterId} 邀请入群 ${session.guildId} 已拒绝（不在白名单）`
        ).catch(() => {})
      }
    }
  })

  // ===== 管理命令 =====
  ctx.command('invitelist', '查看群邀请白名单')
    .action(() => {
      if (whitelist.length === 0) return '白名单为空'
      return `当前白名单（${whitelist.length}人）：\n${whitelist.join('\n')}`
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
