// baidu-drive-sdk-js 的聚合出口。
//
// 平时更推荐按层或按场景引入，含义更明确、打包更小：
//
//   import { createOpenApi } from 'baidu-drive-sdk-js/api';
//   import { createAuth } from 'baidu-drive-sdk-js/api/auth';
//   import { createScene } from 'baidu-drive-sdk-js/scene';
//   import { createFileBrowse } from 'baidu-drive-sdk-js/scene/file-browse';
//
// 依赖方向是单向的：api 是底座（含授权），scene 只依赖 api。
// 聚合入口不改变这个方向，只是把所有导出摊平。

export * from './api';
export * from './scene';
