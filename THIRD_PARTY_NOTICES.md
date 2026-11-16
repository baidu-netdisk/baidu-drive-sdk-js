# Third-Party Notices

本项目（`baidu-drive-sdk-js`）以 Apache License 2.0 发布。运行时依赖的第三方组件与许可见下表；
随包份发的构建产物包含下列组件的代码。

| 组件 | 版本范围 | 许可证 | 用途 |
| --- | --- | --- | --- |
| [spark-md5](https://github.com/satazor/js-spark-md5) | ^3.0.2 | MIT (WTFPL 双许可) | 浏览器没有内置 MD5，上传分片需要计算校验值 |

## 开发期依赖

以下依赖仅用于构建与测试，不进入发布产物，不构成对使用方的分发：

`typescript`、`tsup`、`vitest`、`happy-dom`、`@types/spark-md5`（均为 MIT）。

## 如何更新本文件

新增或升级运行时依赖时，同步更新上表；确认许可证与 Apache-2.0 兼容后再提交。
