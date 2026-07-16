// Web 版入口：先同步安装 window.yibiao（HTTP/SSE 桥），再挂登录闸门。
// 闸门在校验通过后才动态 import('./main') 挂载上游应用，未登录只渲染登录/注册页。
import './shared/web-bridge';
import { mountAuthGate } from './web/auth-gate';

void mountAuthGate();
