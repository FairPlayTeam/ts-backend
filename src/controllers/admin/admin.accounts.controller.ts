import type { NextFunction, Request, RequestHandler, Response } from 'express';
import { toAdminHttpError } from '../admin.errors.js';
import type {
  AdminAccountsQuery,
  BanAdminAccountBody,
  BanAdminAccountParams,
  UpdateAdminAccountRoleBody,
  UpdateAdminAccountRoleParams,
} from '../admin.schemas.js';
import { sendNoStoreJson } from '../http.responses.js';
import type { AuthenticatedRequest } from '../../middleware/auth.js';
import type { AdminControllerDependencies } from './admin.controller.types.js';
import {
  toAdminAccountsResponse,
  toBanAdminAccountResponse,
  toUpdateAdminAccountRoleResponse,
} from './admin.responses.js';

type ListAccountsRequest = Request<unknown, unknown, unknown, AdminAccountsQuery>;
type BanAccountRequest = Request<BanAdminAccountParams, unknown, BanAdminAccountBody>;
type UpdateAccountRoleRequest = Request<
  UpdateAdminAccountRoleParams,
  unknown,
  UpdateAdminAccountRoleBody
>;

export const createAdminAccountsController = (deps: AdminControllerDependencies) => {
  const listAccounts = async (req: ListAccountsRequest, res: Response, next: NextFunction) => {
    try {
      const { cursorCreatedAt, cursorId, limit } = req.query;
      const cursor =
        cursorCreatedAt !== undefined && cursorId !== undefined
          ? {
              createdAt: new Date(cursorCreatedAt),
              id: cursorId,
            }
          : undefined;
      const result = await deps.adminService.listAccounts({
        ...(cursor ? { cursor } : {}),
        ...(limit !== undefined ? { limit } : {}),
      });

      return sendNoStoreJson(res, 200, toAdminAccountsResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  const banAccount: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const banReq = req as BanAccountRequest;
      const result = await deps.adminService.banAccount({
        actorUserId: authenticatedReq.user.id,
        actorRole: authenticatedReq.user.role,
        targetUserId: banReq.params.userId,
        reason: banReq.body.reason,
      });

      return sendNoStoreJson(res, 200, toBanAdminAccountResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  const updateAccountRole: RequestHandler = async (req, res, next) => {
    try {
      const authenticatedReq = req as AuthenticatedRequest;
      const roleReq = req as UpdateAccountRoleRequest;
      const result = await deps.adminService.updateAccountRole({
        actorUserId: authenticatedReq.user.id,
        actorRole: authenticatedReq.user.role,
        targetUserId: roleReq.params.userId,
        role: roleReq.body.role,
      });

      return sendNoStoreJson(res, 200, toUpdateAdminAccountRoleResponse(result));
    } catch (err) {
      next(toAdminHttpError(err));
    }
  };

  return {
    banAccount,
    listAccounts,
    updateAccountRole,
  };
};
