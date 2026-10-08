import bcrypt from "bcryptjs"

// ============================================================================
// 密码哈希
//
// 【为什么不能存明文】
// 数据库一旦泄露（拖库、备份文件被下载、内部人员导出），明文密码等于
// 把所有用户的账号直接送人。而且用户普遍在多个网站用同一个密码，
// 泄露一个等于泄露一片。
//
// 【为什么不用 MD5/SHA256】
// 那些是为「快」设计的，一张消费级显卡每秒能算几十亿次。
// 8 位密码几小时就能穷举完。bcrypt 是故意设计得慢的。
//
// 【bcrypt 的 cost factor】
// 每 +1，计算耗时翻倍。10 大约是 100ms —— 用户登录时完全感觉不到，
// 但攻击者每试一个密码都要付这 100ms，穷举成本涨了几个数量级。
// 不要为了「让登录快一点」把它调低，登录接口本来就不该快。
//
// 【盐（salt）在哪】
// bcrypt.hash 会自动生成随机盐并把盐写进结果字符串里，所以同一个密码
// 每次哈希出来的值都不一样，不需要你手动管盐。
// 格式：$2b$10$<22位盐><31位哈希>
// ============================================================================

const BCRYPT_COST = 10

/** 把明文密码哈希成可入库的字符串 */
export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, BCRYPT_COST)
}

/**
 * 校验明文密码是否匹配哈希值。
 *
 * 【为什么用 bcrypt.compare 而不是 hash 一遍再比字符串】
 * 因为上面说过：同一个密码每次哈希结果都不同（盐是随机的）。
 * compare 会从哈希串里把盐取出来，用同样的盐重新算一遍再比对。
 *
 * 哈希串损坏时 bcrypt 会抛错，这里吞掉返回 false —— 对调用方来说
 * 「哈希坏了」和「密码不对」的处理方式是一样的：不让登录。
 */
export async function verifyPassword(
  plain: string,
  hash: string,
): Promise<boolean> {
  try {
    return await bcrypt.compare(plain, hash)
  } catch {
    return false
  }
}

/**
 * 一个固定字符串的 bcrypt 哈希，内容无人知晓、也永远匹配不上任何输入。
 *
 * 用途见 src/app/actions/auth.ts 的 loginAction：
 * 用户不存在时也拿它跑一次 verifyPassword，让「账号不存在」和「密码错误」
 * 两条分支耗时一致，堵住靠响应时间猜账号的旁路。
 */
export const DUMMY_PASSWORD_HASH =
  "$2b$10$RdmBtdcrg981H50RDfrUjeXh58Bti.BIDmXQDq/PYb.sOSBBm1rDy"
