import type { NextFunction, Request, Response } from 'express';
import { toAdminHttpError } from '../admin.errors.js';
import type { AdminAccountsQuery } from '../admin.schemas.js';
import { sendNoStoreJson } from '../http.responses.js';
import type { AdminControllerDependencies } from './admin.controller.types.js';
import { toAdminAccountsResponse } from './admin.responses.js';

type ListAccountsRequest = Request<unknown, unknown, unknown, AdminAccountsQuery>;

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

  return {
    listAccounts,
  };
};
