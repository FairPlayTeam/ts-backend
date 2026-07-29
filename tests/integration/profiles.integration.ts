import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { UPLOAD_AVATAR_SUCCESS_MESSAGE } from '../../src/services/auth/auth.messages.js';
import { SELF_FOLLOW_MESSAGE } from '../../src/services/profiles.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';
import { createPng, createVerifiedSession } from './support/fixtures.js';
import { OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  createIntegrationApp,
  expectIntegrationReadinessOk,
  resetState,
  startRuntime,
  stopRuntime,
  type TestRuntime,
} from './support/runtime.js';

describe('profiles integration', () => {
  let runtime: TestRuntime | null = null;

  beforeAll(async () => {
    runtime = await startRuntime();
  });

  beforeEach(async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    await resetState(runtime);
  });

  afterAll(async () => {
    await stopRuntime(runtime);
  });

  test('follows and unfollows public profiles through HTTP and Prisma', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const follower = await createVerifiedSession(runtime, {
      email: 'profile-follower@example.com',
      username: 'profile_follower',
    });
    const creator = await createVerifiedSession(runtime, {
      email: 'profile-creator@example.com',
      username: 'profile_creator',
    });

    await request(app)
      .get('/profiles/profile_creator')
      .expect(200)
      .expect((response) => {
        expect(response.body.profile).toEqual(
          expect.objectContaining({
            id: creator.userId,
            username: 'profile_creator',
            followerCount: 0,
            followingCount: 0,
          }),
        );
      });

    await request(app)
      .post('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            message: FOLLOW_PROFILE_SUCCESS_MESSAGE,
            profile: expect.objectContaining({
              id: creator.userId,
              followerCount: 1,
              followingCount: 0,
            }),
          }),
        );
      });

    await expect(
      runtime.prisma.userFollow.findUnique({
        where: {
          followerId_followingId: {
            followerId: follower.userId,
            followingId: creator.userId,
          },
        },
      }),
    ).resolves.toMatchObject({
      followerId: follower.userId,
      followingId: creator.userId,
    });

    await request(app)
      .post('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.followerCount).toBe(1);
      });

    await request(app)
      .get('/profiles/profile_follower')
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.followingCount).toBe(1);
      });

    await request(app)
      .get('/profiles/me/following')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual({
          profiles: [
            {
              id: creator.userId,
              username: 'profile_creator',
              displayName: 'profile_creator',
              avatarUrl: null,
              followedAt: expect.any(String),
            },
          ],
          total: 1,
          nextCursor: null,
        });
      });

    await request(app)
      .post('/profiles/profile_follower/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(400)
      .expect({
        error: 'BadRequest',
        message: SELF_FOLLOW_MESSAGE,
      });

    await request(app)
      .delete('/profiles/profile_creator/follow')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body).toEqual(
          expect.objectContaining({
            message: UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
            profile: expect.objectContaining({
              followerCount: 0,
            }),
          }),
        );
      });

    await expect(runtime.prisma.userFollow.count()).resolves.toBe(0);

    await request(app)
      .get('/profiles/me/following')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect({
        profiles: [],
        total: 0,
        nextCursor: null,
      });
  });

  test('stores uploaded profile media in MinIO and serves it through signed profile URLs', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const { sessionKey, userId } = await createVerifiedSession(runtime, {
      email: 'minio-media@example.com',
      username: 'minio_media_user',
    });
    const avatarInput = await createPng();

    const uploadResponse = await request(app)
      .put('/auth/me/avatar')
      .set('Authorization', `Bearer ${sessionKey}`)
      .attach('avatar', avatarInput, {
        filename: 'avatar.png',
        contentType: 'image/png',
      })
      .expect(200);

    expect(uploadResponse.body).toEqual({
      message: UPLOAD_AVATAR_SUCCESS_MESSAGE,
      avatar: {
        url: expect.any(String),
        mimeType: 'image/webp',
        sizeBytes: expect.any(Number),
        width: 512,
        height: 512,
        updatedAt: expect.any(String),
      },
    });
    const uploadedAvatar = uploadResponse.body.avatar as {
      sizeBytes: number;
      url: string;
    };
    const uploadUrl = new URL(uploadedAvatar.url);
    expect(uploadUrl.origin).toBe(runtime.objectStorageConfig.publicUrl);
    expect(uploadUrl.pathname).toMatch(
      new RegExp(`^/${OBJECT_STORAGE_BUCKET}/users/[0-9a-f-]+/avatar/[0-9a-f-]+\\.webp$`),
    );
    expect(uploadUrl.search).not.toBe('');

    const asset = await runtime.prisma.userMediaAsset.findFirstOrThrow({
      where: {
        userId,
        kind: 'avatar',
      },
      select: {
        bucket: true,
        externalResourceTargetId: true,
        objectKey: true,
        mimeType: true,
        sizeBytes: true,
        width: true,
        height: true,
      },
    });

    expect(asset).toEqual({
      bucket: OBJECT_STORAGE_BUCKET,
      externalResourceTargetId: expect.any(String),
      objectKey: expect.stringMatching(/^users\/[0-9a-f-]+\/avatar\/[0-9a-f-]+\.webp$/),
      mimeType: 'image/webp',
      sizeBytes: uploadedAvatar.sizeBytes,
      width: 512,
      height: 512,
    });

    await expectIntegrationReadinessOk(app);

    const profileResponse = await request(app)
      .get('/auth/me')
      .set('Authorization', `Bearer ${sessionKey}`)
      .expect(200);
    const avatarUrl = profileResponse.body.user.avatarUrl;
    expect(avatarUrl).toEqual(
      expect.stringContaining(`/${OBJECT_STORAGE_BUCKET}/${asset.objectKey}?`),
    );

    const mediaResponse = await fetch(avatarUrl);
    expect(mediaResponse.status).toBe(200);
    expect(mediaResponse.headers.get('content-type')).toContain('image/webp');

    const mediaBody = Buffer.from(await mediaResponse.arrayBuffer());
    expect(mediaBody.length).toBe(asset.sizeBytes);
    const metadata = await sharp(mediaBody).metadata();
    expect(metadata.format).toBe('webp');
    expect(metadata.width).toBe(512);
    expect(metadata.height).toBe(512);

    const replacementInput = await createPng(900, 700);
    await runtime.authService.uploadAvatar({
      userId,
      file: {
        buffer: replacementInput,
        size: replacementInput.length,
      },
    });
    const replacement = await runtime.prisma.userMediaAsset.findFirstOrThrow({
      where: {
        userId,
        kind: 'avatar',
      },
      select: {
        externalResourceTargetId: true,
        objectKey: true,
      },
    });
    const oldTarget = await runtime.prisma.externalResourceTarget.findUniqueOrThrow({
      where: { id: asset.externalResourceTargetId },
    });

    expect(replacement.objectKey).not.toBe(asset.objectKey);
    expect(oldTarget).toMatchObject({
      bucket: OBJECT_STORAGE_BUCKET,
      selector: asset.objectKey,
      selectorKind: 'exact',
      role: 'user_media',
      goal: 'absent',
      state: 'quiescing',
    });
    await expect(
      runtime.objectStorage.headObject({
        bucket: asset.bucket,
        objectKey: asset.objectKey,
      }),
    ).resolves.not.toBeNull();

    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.update({
      where: { id: oldTarget.id },
      data: {
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });
    await expect(runtime.videosService.reconcilePendingExternalResources()).resolves.toMatchObject({
      claimed: 0,
      confirmed: 0,
    });
    await expect(runtime.authService.reconcileUserMediaTargets({})).resolves.toMatchObject({
      mediaTargetsConfirmed: 1,
      mediaTargetsFailed: 0,
    });
    await expect(
      runtime.objectStorage.headObject({
        bucket: asset.bucket,
        objectKey: asset.objectKey,
      }),
    ).resolves.toBeNull();
    await expect(
      runtime.prisma.externalResourceTarget.findUniqueOrThrow({
        where: { id: oldTarget.id },
        select: { state: true },
      }),
    ).resolves.toEqual({ state: 'confirmed_absent' });
  });

  test('serializes two concurrent user-media replacements onto one current asset', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'concurrent-media@example.com',
      username: 'concurrent_media',
    });
    const [firstAvatar, secondAvatar] = await Promise.all([
      createPng(800, 600),
      createPng(900, 700),
    ]);

    await Promise.all([
      runtime.authService.uploadAvatar({
        userId: owner.userId,
        file: {
          buffer: firstAvatar,
          size: firstAvatar.length,
        },
      }),
      runtime.authService.uploadAvatar({
        userId: owner.userId,
        file: {
          buffer: secondAvatar,
          size: secondAvatar.length,
        },
      }),
    ]);

    const assets = await runtime.prisma.userMediaAsset.findMany({
      where: {
        userId: owner.userId,
        kind: 'avatar',
      },
      select: {
        externalResourceTargetId: true,
      },
    });
    const targets = await runtime.prisma.externalResourceTarget.findMany({
      where: {
        userId: owner.userId,
        role: 'user_media',
      },
      select: {
        goal: true,
        id: true,
        quiescenceNotBefore: true,
        state: true,
      },
    });

    expect(assets).toHaveLength(1);
    expect(targets).toHaveLength(2);
    const currentTarget = targets.find(({ id }) => id === assets[0]?.externalResourceTargetId);
    const replacedTarget = targets.find(({ id }) => id !== assets[0]?.externalResourceTargetId);

    expect(currentTarget).toMatchObject({
      goal: 'present',
      quiescenceNotBefore: null,
      state: 'confirmed_present',
    });
    expect(replacedTarget).toMatchObject({
      goal: 'absent',
      quiescenceNotBefore: expect.any(Date),
      state: 'quiescing',
    });
  });
});
