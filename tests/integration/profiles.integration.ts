import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ObjectStorageUnavailableError } from '../../src/lib/objectStorage.js';
import { OperationTimeoutError } from '../../src/lib/operationMetrics.js';
import { UPLOAD_AVATAR_SUCCESS_MESSAGE } from '../../src/services/auth/auth.messages.js';
import {
  PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE,
  SELF_FOLLOW_MESSAGE,
} from '../../src/services/profiles.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';
import { createPng, createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
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

  test('stores uploaded profile media in MinIO and proxies it through opaque profile paths', async () => {
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
    expect(uploadedAvatar.url).toBe('/profiles/minio_media_user/avatar');
    const bannerInput = await createPng(1_600, 600);
    await request(app)
      .put('/auth/me/banner')
      .set('Authorization', `Bearer ${sessionKey}`)
      .attach('banner', bannerInput, {
        filename: 'banner.png',
        contentType: 'image/png',
      })
      .expect(200);

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
    const avatarUrl = profileResponse.body.user.avatarUrl as string;
    const bannerUrl = profileResponse.body.user.bannerUrl as string;
    expect(avatarUrl).toBe('/profiles/minio_media_user/avatar');
    expect(bannerUrl).toBe('/profiles/minio_media_user/banner');

    const mediaResponse = await request(app)
      .get(avatarUrl)
      .expect(200)
      .expect('Cache-Control', 'private, no-cache')
      .expect('Content-Type', /image\/webp/);
    expect(mediaResponse.headers.location).toBeUndefined();
    await request(app)
      .get(bannerUrl)
      .expect(200)
      .expect('Cache-Control', 'private, no-cache')
      .expect('Content-Type', /image\/webp/)
      .expect((response) => {
        expect(response.headers.location).toBeUndefined();
      });

    const mediaBody = mediaResponse.body as Buffer;
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

  test('returns a clean 404 for an admin-list avatar link followed after account deletion', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const admin = await createVerifiedSession(runtime, {
      email: 'profile-list-admin@example.com',
      username: 'profile_list_admin',
    });
    await runtime.prisma.user.update({
      where: { id: admin.userId },
      data: { role: 'admin' },
    });
    const target = await createVerifiedSession(runtime, {
      email: 'deleted-list-profile@example.com',
      username: 'deleted_list_profile',
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: target.userId,
      file: { buffer: avatar, size: avatar.length },
    });

    const accountsResponse = await request(app)
      .get('/admin/users?limit=100')
      .set('Authorization', `Bearer ${admin.sessionKey}`)
      .expect(200);
    const listedTarget = (
      accountsResponse.body.accounts as { id: string; avatarUrl: string }[]
    ).find(({ id }) => id === target.userId);

    expect(listedTarget?.avatarUrl).toBe('/profiles/deleted_list_profile/avatar');
    await runtime.authService.deleteAccount({
      userId: target.userId,
      currentPassword: INITIAL_PASSWORD,
    });
    await request(app)
      .get(listedTarget?.avatarUrl ?? '')
      .expect(404)
      .expect({
        error: 'NotFound',
        message: PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE,
      });
  });

  test('keeps an avatar proxy read healthy while video reconciliation times out', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const app = await createIntegrationApp(runtime);
    const owner = await createVerifiedSession(runtime, {
      email: 'storage-isolation@example.com',
      username: 'storage_isolation',
    });
    const avatar = await createPng();
    await runtime.authService.uploadAvatar({
      userId: owner.userId,
      file: { buffer: avatar, size: avatar.length },
    });
    const video = await runtime.videosService.createVideo({
      userId: owner.userId,
      title: 'Storage isolation timeout probe',
      description: null,
      tags: [],
      license: 'all_rights_reserved',
      visibility: 'unlisted',
      allowComments: true,
    });
    const dueAt = new Date(Date.now() - 1_000);
    await runtime.prisma.externalResourceTarget.create({
      data: {
        userId: owner.userId,
        videoId: video.video.id,
        bucket: runtime.videoObjectStorage.bucket,
        selector: `isolation/${randomUUID()}.mp4`,
        selectorKind: 'exact',
        role: 'source',
        generation: randomUUID(),
        expectedSizeBytes: null,
        mayHaveMultipartUpload: false,
        goal: 'absent',
        state: 'quiescing',
        quiescenceNotBefore: dueAt,
        nextAttemptAt: dueAt,
      },
    });

    let markAvatarReadStarted: (() => void) | undefined;
    let markVideoDeleteStarted: (() => void) | undefined;
    const avatarReadStarted = new Promise<void>((resolve) => {
      markAvatarReadStarted = resolve;
    });
    const videoDeleteStarted = new Promise<void>((resolve) => {
      markVideoDeleteStarted = resolve;
    });
    const originalAvatarRead = runtime.objectStorage.readObject;
    const originalVideoDelete = runtime.videoObjectStorage.deleteObject;
    let avatarReadCalls = 0;
    let videoDeleteCalls = 0;

    runtime.objectStorage.readObject = async (input) => {
      avatarReadCalls += 1;
      markAvatarReadStarted?.();
      await videoDeleteStarted;

      return originalAvatarRead(input);
    };
    runtime.videoObjectStorage.deleteObject = async () => {
      videoDeleteCalls += 1;
      markVideoDeleteStarted?.();
      await avatarReadStarted;
      throw new ObjectStorageUnavailableError(undefined, {
        cause: new OperationTimeoutError('objectStorage.deleteObject', 1),
      });
    };

    try {
      const [reconciliation, avatarResponse] = await Promise.all([
        runtime.videoExternalResources.reconcileDue({ roles: ['source'], limit: 1 }),
        request(app).get('/profiles/storage_isolation/avatar'),
      ]);

      expect(reconciliation).toMatchObject({ claimed: 1, confirmed: 0, failed: 1 });
      expect(avatarResponse.status).toBe(200);
      expect(avatarResponse.headers.location).toBeUndefined();
      expect(Buffer.isBuffer(avatarResponse.body)).toBe(true);
      expect(avatarReadCalls).toBe(1);
      expect(videoDeleteCalls).toBe(1);
    } finally {
      runtime.objectStorage.readObject = originalAvatarRead;
      runtime.videoObjectStorage.deleteObject = originalVideoDelete;
    }
  });
});
