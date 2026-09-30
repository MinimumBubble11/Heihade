/**
 * 返回导航模块：从 menu / custom / mode-select / setting 返回播放页
 *
 * 替代原 loading.ux 中转页：读取 lastTargetPage（上次点击的音效页），
 * 直接跳回对应播放页；无记录或旧版本残留路径回退默认音效（雷军）。
 * 统一使用 replace + clearTask 清理页面栈，避免返回后残留中间页。
 */
import router from '@system.router'
import settings from './settings'

const DEFAULT_PLAY = '/pages/play?name=Leijun'

export default {
  // 返回上次播放页（无记录回退默认音效）
  backToPlay() {
    settings.get('lastTargetPage').then((value) => {
      if (value && value.indexOf('/pages/play') === 0) {
        router.replace({ uri: value, params: { ___PARAM_LAUNCH_FLAG___: 'clearTask' } })
      } else {
        router.replace({ uri: DEFAULT_PLAY, params: { ___PARAM_LAUNCH_FLAG___: 'clearTask' } })
      }
    })
  }
}
