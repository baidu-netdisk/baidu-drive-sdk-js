import { describe, expect, it } from 'vitest';

import { Errno, errnoMessage, hasErrnoMessage, needsReauth } from './errno';
import { ApiError, assertOpenApiOk, isErrno } from './openapi';
import { HttpError } from './transport';

describe('errnoMessage', () => {
  it('收录的码给中文说明', () => {
    expect(errnoMessage(-9)).toBe('文件或目录不存在');
    expect(errnoMessage(31064)).toBe('上传路径错误，必须在 /apps/<应用名> 下');
  });

  it('没收录的码带上原始码兜底，不返回空串', () => {
    expect(errnoMessage(99999)).toBe('接口返回错误码 99999');
    expect(hasErrnoMessage(99999)).toBe(false);
  });

  it('errno 0 也收录了，避免调用方拿到兜底文案', () => {
    expect(hasErrnoMessage(0)).toBe(true);
  });
});

describe('needsReauth', () => {
  it('凭据类错误要重新授权', () => {
    expect([-6, 20016, 20017, 31045].every(needsReauth)).toBe(true);
  });

  it('其他错误不要求重新授权', () => {
    expect([-9, 111, 31034, 31061].some(needsReauth)).toBe(false);
  });
});

describe('assertOpenApiOk 的文案', () => {
  it('收录的码优先用中文说明，接口原文留在 errmsg', () => {
    try {
      assertOpenApiOk({ errno: -6, errmsg: 'Invalid Bduss', request_id: 1 }, '/x');
      expect.unreachable('应该抛错');
    } catch (error) {
      expect(error).toBeInstanceOf(ApiError);
      expect((error as ApiError).message).toBe('身份验证失败，请重新授权');
      expect((error as ApiError).errmsg).toBe('Invalid Bduss');
    }
  });

  it('没收录的码退回接口原文', () => {
    try {
      assertOpenApiOk({ errno: 99999, show_msg: '接口自己的说明' }, '/x');
      expect.unreachable('应该抛错');
    } catch (error) {
      expect((error as ApiError).message).toBe('接口自己的说明');
    }
  });

  it('既没收录也没原文时给带码的兜底文案', () => {
    try {
      assertOpenApiOk({ errno: 88888 }, '/x');
      expect.unreachable('应该抛错');
    } catch (error) {
      expect((error as ApiError).message).toBe('接口返回错误码 88888');
      expect((error as ApiError).errmsg).toBe('');
    }
  });

  it('errno 0 不抛错', () => {
    expect(() => assertOpenApiOk({ errno: 0 }, '/x')).not.toThrow();
  });
});

describe('Errno 常量与 isErrno', () => {
  it('常量值与 Go SDK 的 api.Errno* 对齐', () => {
    expect(Errno.Success).toBe(0);
    expect(Errno.AccessDenied).toBe(-6);
    expect(Errno.FileNameIllegal).toBe(-7);
    expect(Errno.FileAlreadyExist).toBe(-8);
    expect(Errno.PathNotExist).toBe(-9);
    expect(Errno.SpaceFull).toBe(-10);
    expect(Errno.ParamError).toBe(2);
    expect(Errno.AsyncTaskRunning).toBe(111);
    expect(Errno.AccessTokenExpired).toBe(20016);
    expect(Errno.AccessTokenInvalid).toBe(20017);
    expect(Errno.LimitExceeded).toBe(31034);
    expect(Errno.AccessTokenVerifyFailed).toBe(31045);
  });

  it('每个常量都能取到收录的中文文案', () => {
    for (const value of Object.values(Errno)) {
      expect(hasErrnoMessage(value)).toBe(true);
    }
  });

  it('isErrno 同时认 ApiError 和 HttpError.body.error_code 两个载体', () => {
    const apiError = (() => {
      try {
        assertOpenApiOk({ errno: 20016 }, '/x');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(isErrno(apiError, Errno.AccessTokenExpired)).toBe(true);
    expect(isErrno(apiError, Errno.PathNotExist)).toBe(false);

    const httpError = new HttpError('HTTP 404', {
      kind: 'http',
      url: '/x',
      status: 404,
      body: { error_code: 31066 }
    });
    expect(isErrno(httpError, 31066)).toBe(true);
    expect(isErrno(new Error('boom'), Errno.PathNotExist)).toBe(false);
    expect(isErrno(null, Errno.Success)).toBe(false);
  });

  it('需要重新授权的判定与 Go 版语义一致', () => {
    expect(needsReauth(Errno.AccessDenied)).toBe(true);
    expect(needsReauth(Errno.AccessTokenExpired)).toBe(true);
    expect(needsReauth(Errno.AccessTokenInvalid)).toBe(true);
    expect(needsReauth(Errno.AccessTokenVerifyFailed)).toBe(true);
    expect(needsReauth(Errno.LimitExceeded)).toBe(false);
  });
});
