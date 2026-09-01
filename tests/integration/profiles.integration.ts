import { randomUUID } from 'node:crypto';
import request from 'supertest';
import sharp from '../../src/lib/sharp.js';
import {
  Prisma,
  type PrismaClient,
  type VideoModerationStatus,
  type VideoProcessingStatus,
  type VideoVisibility,
} from '@prisma/client';
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'vitest';
import { ObjectStorageUnavailableError } from '../../src/lib/objectStorage.js';
import { OperationTimeoutError } from '../../src/lib/operationMetrics.js';
import { createExternalResourceReconciler } from '../../src/services/externalResources.js';
import { UPLOAD_AVATAR_SUCCESS_MESSAGE } from '../../src/services/auth/auth.messages.js';
import {
  PUBLIC_PROFILE_MEDIA_NOT_FOUND_MESSAGE,
  SELF_FOLLOW_MESSAGE,
} from '../../src/services/profiles.errors.js';
import {
  FOLLOW_PROFILE_SUCCESS_MESSAGE,
  UNFOLLOW_PROFILE_SUCCESS_MESSAGE,
} from '../../src/services/profiles/profiles.messages.js';
import type { VideosService } from '../../src/services/videos.types.js';
import { createPng, createVerifiedSession, INITIAL_PASSWORD } from './support/fixtures.js';
import { OBJECT_STORAGE_BUCKET } from './support/infrastructure.js';
import {
  coordinateWhilePaused,
  throwCollectedErrors,
  waitForBarrier,
} from './support/asyncBarriers.js';
import { waitForPostgresLockWaiters } from './support/postgresLocks.js';
import {
  createIntegrationAuthService,
  createIntegrationApp,
  createIntegrationVideosService,
  createPostgresApplicationName,
  createPrismaClient,
  expectIntegrationReadinessOk,
  resetState,
  startRuntime,
  stopRuntime,
  testLogger,
  type TestRuntime,
} from './support/runtime.js';

const createMediaPersistenceBarrierPrisma = (
  prisma: PrismaClient,
  {
    afterFirstRead,
    afterFirstUpsert,
  }: {
    afterFirstRead: (result: unknown) => Promise<void>;
    afterFirstUpsert?: () => Promise<void>;
  },
): PrismaClient => {
  let readObserved = false;
  let upsertObserved = false;

  return new Proxy(prisma, {
    get(target, property) {
      if (property === '$transaction') {
        return async <T>(
          run: (tx: Prisma.TransactionClient) => Promise<T>,
          options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
        ): Promise<T> =>
          target.$transaction(async (tx) => {
            const observedTransaction = new Proxy(tx, {
              get(transactionTarget, transactionProperty) {
                if (transactionProperty === 'userMediaAsset') {
                  return new Proxy(transactionTarget.userMediaAsset, {
                    get(mediaTarget, mediaProperty) {
                      if (mediaProperty === 'findUnique') {
                        return async (
                          args: Parameters<typeof mediaTarget.findUnique>[0],
                        ): Promise<Awaited<ReturnType<typeof mediaTarget.findUnique>>> => {
                          const result = await mediaTarget.findUnique(args);

                          if (!readObserved) {
                            readObserved = true;
                            await afterFirstRead(result);
                          }

                          return result;
                        };
                      }

                      if (mediaProperty === 'upsert') {
                        return async (
                          args: Parameters<typeof mediaTarget.upsert>[0],
                        ): Promise<Awaited<ReturnType<typeof mediaTarget.upsert>>> => {
                          const result = await mediaTarget.upsert(args);

                          if (!upsertObserved && afterFirstUpsert) {
                            upsertObserved = true;
                            await afterFirstUpsert();
                          }

                          return result;
                        };
                      }

                      const value = Reflect.get(mediaTarget, mediaProperty, mediaTarget) as unknown;

                      return typeof value === 'function' ? value.bind(mediaTarget) : value;
                    },
                  });
                }

                const value = Reflect.get(
                  transactionTarget,
                  transactionProperty,
                  transactionTarget,
                ) as unknown;

                return typeof value === 'function' ? value.bind(transactionTarget) : value;
              },
            });

            return run(observedTransaction);
          }, options);
      }

      const value = Reflect.get(target, property, target) as unknown;

      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
};

const createProfileCatalogVideo = async (
  runtime: TestRuntime,
  {
    createdAt,
    moderationStatus = 'approved',
    ownerId,
    processingStatus = 'ready',
    title,
    visibility = 'public',
  }: {
    createdAt: Date;
    moderationStatus?: VideoModerationStatus;
    ownerId: string;
    processingStatus?: VideoProcessingStatus;
    title: string;
    visibility?: VideoVisibility;
  },
) => {
  const created = await runtime.videosService.createVideo({
    userId: ownerId,
    title,
    description: 'Internal catalog description that must not leak.',
    tags: ['internal-profile-catalog-tag'],
    license: 'all_rights_reserved',
    allowComments: true,
  });

  return runtime.prisma.video.update({
    where: { id: created.video.id },
    data: {
      createdAt,
      moderationStatus,
      processingStatus,
      ...(processingStatus === 'ready' ? { durationSeconds: 19 } : {}),
      visibility,
    },
    select: {
      publicId: true,
    },
  });
};

const createCatalogTransactionBarrierService = (
  runtime: TestRuntime,
  beforeTransaction: (options?: {
    isolationLevel?: Prisma.TransactionIsolationLevel;
  }) => Promise<void>,
): VideosService => {
  const barrierPrisma = {
    $transaction: async <T>(
      run: (tx: Prisma.TransactionClient) => Promise<T>,
      options?: { isolationLevel?: Prisma.TransactionIsolationLevel },
    ): Promise<T> => {
      await beforeTransaction(options);

      return runtime.prisma.$transaction(run, options);
    },
  } as unknown as PrismaClient;

  return createIntegrationVideosService(
    barrierPrisma,
    runtime.videoObjectStorage,
    runtime.videoExternalResources,
  );
};

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

    await request(app)
      .get('/profiles/profile_creator')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.isFollowing).toBe(true);
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

    await request(app)
      .get('/profiles/profile_creator')
      .set('Authorization', `Bearer ${follower.sessionKey}`)
      .expect(200)
      .expect((response) => {
        expect(response.body.profile.isFollowing).toBe(false);
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

  test('lists only one creator public catalog with stable pagination and the feed DTO', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const owner = await createVerifiedSession(runtime, {
      email: 'profile-video-owner@example.com',
      username: 'profile_video_owner',
    });
    const otherOwner = await createVerifiedSession(runtime, {
      email: 'profile-video-other@example.com',
      username: 'profile_video_other',
    });
    await runtime.prisma.user.update({
      where: { id: owner.userId },
      data: { displayName: 'Profile Video Owner' },
    });
    const dates = [
      new Date('2026-07-01T00:00:00.000Z'),
      new Date('2026-07-02T00:00:00.000Z'),
      new Date('2026-07-03T00:00:00.000Z'),
    ] as const;
    const [oldest, middle, newest, other] = await Promise.all([
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Profile oldest',
        createdAt: dates[0],
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Profile middle',
        createdAt: dates[1],
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Profile newest',
        createdAt: dates[2],
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: otherOwner.userId,
        title: 'Other creator video',
        createdAt: new Date('2026-07-04T00:00:00.000Z'),
      }),
    ]);
    const hidden = await Promise.all([
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Hidden rejected',
        createdAt: new Date('2026-07-05T00:00:00.000Z'),
        moderationStatus: 'rejected',
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Hidden unlisted',
        createdAt: new Date('2026-07-06T00:00:00.000Z'),
        visibility: 'unlisted',
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Hidden pending',
        createdAt: new Date('2026-07-07T00:00:00.000Z'),
        moderationStatus: 'pending',
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: 'Hidden non-ready',
        createdAt: new Date('2026-07-08T00:00:00.000Z'),
        processingStatus: 'processing',
      }),
    ]);
    const app = await createIntegrationApp(runtime);
    const firstPage = await request(app)
      .get('/profiles/profile_video_owner/videos')
      .query({ limit: 2 })
      .expect(200);

    expect(firstPage.headers['cache-control']).toBe('no-store');
    expect(firstPage.body.total).toBe(3);
    expect(firstPage.body.videos.map(({ publicId }: { publicId: string }) => publicId)).toEqual([
      newest.publicId,
      middle.publicId,
    ]);
    expect(firstPage.body.nextCursor).toEqual({
      createdAt: dates[1].toISOString(),
      publicId: middle.publicId,
    });

    const secondPage = await request(app)
      .get('/profiles/profile_video_owner/videos')
      .query({
        limit: 2,
        cursorCreatedAt: firstPage.body.nextCursor.createdAt,
        cursorPublicId: firstPage.body.nextCursor.publicId,
      })
      .expect(200);

    expect(secondPage.body).toEqual({
      videos: [
        {
          publicId: oldest.publicId,
          title: 'Profile oldest',
          createdAt: dates[0].toISOString(),
          thumbnailPath: null,
          creator: {
            username: 'profile_video_owner',
            displayName: 'Profile Video Owner',
          },
          viewCount: 0,
          duration: 19,
        },
      ],
      total: 3,
      nextCursor: null,
    });

    const returnedPublicIds = [
      ...firstPage.body.videos.map(({ publicId }: { publicId: string }) => publicId),
      ...secondPage.body.videos.map(({ publicId }: { publicId: string }) => publicId),
    ];
    expect(returnedPublicIds).not.toContain(other.publicId);
    for (const hiddenVideo of hidden) {
      expect(returnedPublicIds).not.toContain(hiddenVideo.publicId);
    }

    const card = firstPage.body.videos[0] as Record<string, unknown>;
    expect(Object.keys(card).sort()).toEqual(
      [
        'createdAt',
        'creator',
        'duration',
        'publicId',
        'thumbnailPath',
        'title',
        'viewCount',
      ].sort(),
    );
    expect(Object.keys(card.creator as Record<string, unknown>).sort()).toEqual(
      ['displayName', 'username'].sort(),
    );
    for (const forbidden of [
      'id',
      'ownerId',
      'moderationStatus',
      'processingStatus',
      'ratingSum',
      'ratingCount',
      'thumbnailObjectKey',
      'hlsMasterObjectKey',
      'objectKey',
    ]) {
      expect(card).not.toHaveProperty(forbidden);
    }

    const feed = await request(app).get('/videos').query({ limit: 100 }).expect(200);
    const matchingFeedCard = (
      feed.body.videos as Array<Record<string, unknown> & { publicId: string }>
    ).find(({ publicId }) => publicId === newest.publicId);
    expect(matchingFeedCard).toEqual(card);
  });

  test('returns the same 404 as the profile for missing, unverified, and banned creators', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }

    const unverified = await createVerifiedSession(runtime, {
      email: 'profile-videos-unverified@example.com',
      username: 'profile_vid_unver',
    });
    const banned = await createVerifiedSession(runtime, {
      email: 'profile-videos-banned@example.com',
      username: 'profile_vid_banned',
    });
    await Promise.all([
      createProfileCatalogVideo(runtime, {
        ownerId: unverified.userId,
        title: 'Unverified creator public video',
        createdAt: new Date('2026-07-01T00:00:00.000Z'),
      }),
      createProfileCatalogVideo(runtime, {
        ownerId: banned.userId,
        title: 'Banned creator public video',
        createdAt: new Date('2026-07-02T00:00:00.000Z'),
      }),
    ]);
    await Promise.all([
      runtime.prisma.user.update({
        where: { id: unverified.userId },
        data: { isVerified: false },
      }),
      runtime.prisma.user.update({
        where: { id: banned.userId },
        data: { isBanned: true, bannedAt: new Date('2026-07-03T00:00:00.000Z') },
      }),
    ]);
    const app = await createIntegrationApp(runtime);

    for (const username of ['profile_vid_missing', 'profile_vid_unver', 'profile_vid_banned']) {
      const profile = await request(app).get(`/profiles/${username}`).expect(404);
      const videos = await request(app).get(`/profiles/${username}/videos`).expect(404);

      expect(videos.body).toEqual(profile.body);
      expect(videos.body).toEqual({
        error: 'NotFound',
        message: 'Public profile not found',
      });
    }
  });

  test('revalidates profile visibility after resolution and before the catalog snapshot', async () => {
    if (!runtime) {
      throw new Error('Integration runtime was not started');
    }
    const activeRuntime = runtime;

    for (const stateChange of ['delete', 'ban', 'unverify'] as const) {
      const username = `race_${stateChange}`;
      const owner = await createVerifiedSession(runtime, {
        email: `race-${stateChange}@example.com`,
        username,
      });
      await createProfileCatalogVideo(runtime, {
        ownerId: owner.userId,
        title: `Profile visibility ${stateChange} race`,
        createdAt: new Date('2026-07-04T00:00:00.000Z'),
      });
      const transactionStarted = Promise.withResolvers<
        Prisma.TransactionIsolationLevel | undefined
      >();
      const releaseTransaction = Promise.withResolvers<void>();
      const barrierService = createCatalogTransactionBarrierService(runtime, async (options) => {
        transactionStarted.resolve(options?.isolationLevel);
        await releaseTransaction.promise;
      });
      const app = await createIntegrationApp(runtime, { videosService: barrierService });
      const pendingResponse = request(app)
        .get(`/profiles/${username}/videos`)
        .then((response) => response);

      const [response] = await coordinateWhilePaused({
        firstBarrierDescription: `the ${stateChange} profile-catalog transaction`,
        firstOperation: pendingResponse,
        firstPaused: transactionStarted.promise,
        releaseFirst: releaseTransaction.resolve,
        runWhilePaused: async () => {
          if (stateChange === 'delete') {
            await activeRuntime.prisma.user.delete({ where: { id: owner.userId } });
          } else if (stateChange === 'ban') {
            await activeRuntime.prisma.user.update({
              where: { id: owner.userId },
              data: {
                isBanned: true,
                bannedAt: new Date('2026-07-04T01:00:00.000Z'),
              },
            });
          } else {
            await activeRuntime.prisma.user.update({
              where: { id: owner.userId },
              data: { isVerified: false },
            });
          }
        },
        whilePausedDescription: `the committed profile ${stateChange} transition`,
      });
      const isolationLevel = await transactionStarted.promise;

      expect(isolationLevel).toBe(Prisma.TransactionIsolationLevel.RepeatableRead);
      expect(response.status).toBe(404);
      expect(response.body).toEqual({
        error: 'NotFound',
        message: 'Public profile not found',
      });
      if (stateChange !== 'delete') {
        await expect(
          runtime.prisma.video.count({ where: { ownerId: owner.userId } }),
        ).resolves.toBe(1);
      }
    }
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
    const firstApplicationName = createPostgresApplicationName();
    const secondApplicationName = createPostgresApplicationName();
    const firstPrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: firstApplicationName,
    });
    const secondPrisma = createPrismaClient(runtime.databaseUrl, {
      applicationName: secondApplicationName,
    });
    const bothReadPreviousAsset = Promise.withResolvers<void>();
    const releaseFirstRead = Promise.withResolvers<void>();
    const releaseSecondRead = Promise.withResolvers<void>();
    const firstUpserted = Promise.withResolvers<void>();
    const releaseFirstCommit = Promise.withResolvers<void>();
    let readCount = 0;
    const reportRead = (release: Promise<void>) => async (result: unknown) => {
      expect(result).toBeNull();
      readCount += 1;

      if (readCount === 2) {
        bothReadPreviousAsset.resolve();
      }

      await release;
    };
    const firstObservedPrisma = createMediaPersistenceBarrierPrisma(firstPrisma, {
      afterFirstRead: reportRead(releaseFirstRead.promise),
      afterFirstUpsert: async () => {
        firstUpserted.resolve();
        await releaseFirstCommit.promise;
      },
    });
    const secondObservedPrisma = createMediaPersistenceBarrierPrisma(secondPrisma, {
      afterFirstRead: reportRead(releaseSecondRead.promise),
    });
    const firstExternalResources = createExternalResourceReconciler({
      prisma: firstObservedPrisma,
      objectStorage: runtime.objectStorage,
      clock: { now: () => new Date() },
      logger: testLogger,
    });
    const secondExternalResources = createExternalResourceReconciler({
      prisma: secondObservedPrisma,
      objectStorage: runtime.objectStorage,
      clock: { now: () => new Date() },
      logger: testLogger,
    });
    const firstService = createIntegrationAuthService(
      firstObservedPrisma,
      runtime.objectStorage,
      runtime.delivered,
      firstExternalResources,
    );
    const secondService = createIntegrationAuthService(
      secondObservedPrisma,
      runtime.objectStorage,
      runtime.delivered,
      secondExternalResources,
    );
    const firstUpload = firstService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: firstAvatar,
        size: firstAvatar.length,
      },
    });
    const secondUpload = secondService.uploadAvatar({
      userId: owner.userId,
      file: {
        buffer: secondAvatar,
        size: secondAvatar.length,
      },
    });
    const coordinationErrors = new Set<unknown>();

    try {
      await waitForBarrier({
        description: 'both user-media reads of the previous asset',
        operations: [firstUpload, secondUpload],
        signal: bothReadPreviousAsset.promise,
      });
      releaseFirstRead.resolve();
      await waitForBarrier({
        description: 'the first uncommitted user-media upsert',
        operations: [firstUpload],
        signal: firstUpserted.promise,
      });
      releaseSecondRead.resolve();
      await waitForPostgresLockWaiters(runtime.prisma, {
        applicationNames: [secondApplicationName],
        expectedCount: 1,
        queryFragments: ['user_media_assets'],
      });
      releaseFirstCommit.resolve();
      await Promise.all([firstUpload, secondUpload]);
    } catch (error) {
      coordinationErrors.add(error);
    } finally {
      releaseFirstRead.resolve();
      releaseSecondRead.resolve();
      releaseFirstCommit.resolve();
      const operationResults = await Promise.allSettled([firstUpload, secondUpload]);

      for (const result of operationResults) {
        if (result.status === 'rejected') {
          coordinationErrors.add(result.reason);
        }
      }

      const disconnectResults = await Promise.allSettled([
        firstPrisma.$disconnect(),
        secondPrisma.$disconnect(),
      ]);

      for (const result of disconnectResults) {
        if (result.status === 'rejected') {
          coordinationErrors.add(result.reason);
        }
      }
    }

    throwCollectedErrors([...coordinationErrors], 'Concurrent user-media coordination failed');

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
