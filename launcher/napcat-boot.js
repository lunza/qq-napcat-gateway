// [2026-11-12] NapCat 入口包装器（放入 QQ 热更包：QQUpdate.app/Contents/Resources/app/）
// 1) 有 --no-sandbox 参数 → 直接加载 NapCat（等价于 NapCat 官方 loadNapCat.js）
// 2) 否则 → 加载本包自己的 app_launcher，再只启动一次 NapCat（挂到 QQ 的 Node 运行时），
//    之后按 Enter 键不会反复初始化 NapCat。修复官方 loadNapCat.js 每次 require 都重新 import 的问题。
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// 注意：QQ 运行在沙盒容器里，os.homedir() 会被重定向到
// ~/Library/Containers/com.tencent.qq/Data 之下，不能用来拼绝对路径，
// 这里改用环境变量并让启动器显式传入 NAPCAT_MAIN_PATH。
// [2026-11-21] 开源发布：去除硬编码用户路径。未显式传入时按 macOS QQ 沙盒容器
// 的标准位置用 os.homedir() 推导（此时进程尚未进入沙盒重定向，homedir 是真实家目录）。
const os = require('node:os');
const DEFAULT_NAPCAT_MAIN = path.join(
  os.homedir(),
  'Library/Containers/com.tencent.qq/Data/Documents/napcat/napcat.mjs',
);
const NAPCAT_MAIN = process.env.NAPCAT_MAIN_PATH || DEFAULT_NAPCAT_MAIN;
const loadNapcat = process.argv.includes('--no-sandbox');

if (loadNapcat) {
  import(pathToFileURL(NAPCAT_MAIN).href);
} else {
  const pkg = require(path.join(__dirname, 'package.json'));
  require(path.join(__dirname, 'app_launcher/index.js'));
  const startNapcatOnce = () => {
    if (global.__napcatStarted) return;
    global.__napcatStarted = true;
    console.log('[napcat-boot] 首次 require，加载 NapCat 并等待 ' + (process.env.NAPCAT_QUICK_ACCOUNT || '扫码'));
    import(pathToFileURL(NAPCAT_MAIN).href).catch((e) => console.error('[napcat-boot] NapCat 加载失败', e));
  };
  setImmediate(() => {
    if (global.launcher && global.launcher.installPathPkgJson) {
      global.launcher.installPathPkgJson.main = ((version) => {
        if (version >= 29271) return './application.asar/app_launcher/index.js';
        if (version >= 28060) return './application/app_launcher/index.js';
        return './app_launcher/index.js';
      })(pkg.buildVersion);
    }
    // 延后 500ms，等 app_launcher 初始化完成后再起 NapCat
    setTimeout(startNapcatOnce, 500);
  });
}
