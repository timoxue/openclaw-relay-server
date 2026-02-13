import { describe, it, expect, beforeAll } from 'vitest';
import { tokenService } from '../src/services/token';
import { database } from '../src/services/database';

describe('Token Service', () => {
  const testFeishuId = 'test_user_123';

  beforeAll(() => {
    // Clear test data if exists
    const user = database.getUserByFeishuId(testFeishuId);
    if (user) {
      // In production, you would delete the test user here
      console.log('Test user already exists, will reuse');
    }
  });

  it('should generate a valid token', () => {
    const token = tokenService.generateToken({
      userId: 1,
      feishuUserId: testFeishuId,
    });

    expect(token).toBeTruthy();
    expect(typeof token).toBe('string');
  });

  it('should verify a valid token', () => {
    const payload = { userId: 1, feishuUserId: testFeishuId };
    const token = tokenService.generateToken(payload);
    const verified = tokenService.verifyToken(token);

    expect(verified).toEqual(payload);
  });

  it('should reject an invalid token', () => {
    const verified = tokenService.verifyToken('invalid_token');
    expect(verified).toBeNull();
  });

  it('should create or get user token', () => {
    const token = tokenService.getOrCreateUserToken(testFeishuId);
    expect(token).toBeTruthy();

    // 再次调用应该返回相同的 token (未过期时)
    const token2 = tokenService.getOrCreateUserToken(testFeishuId);
    expect(token2).toBe(token);
  });
});
