// Web 版入口：先同步安装 window.yibiao（HTTP/SSE 桥），再加载原渲染进程入口。
// import 顺序保证 web-bridge 的副作用在 main 求值前完成。
import './shared/web-bridge';
import './main';
