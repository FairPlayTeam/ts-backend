import type { Express } from 'express';
import { Router } from 'express';
import { apiLimiter, adminLimiter } from '../middleware/limiters.js';
import { readdir, stat } from 'node:fs/promises';
import { extname, posix as pathPosix } from 'node:path';

function routePathFromFile(relativeFile: string): string {
  const normalized = relativeFile.replace(/\\/g, '/');
  const noExt = normalized.replace(/\.(ts|js)$/, '');

  if (noExt === 'index') {
    return '/';
  }

  if (noExt.endsWith('/index')) {
    const base = noExt.slice(0, -'/index'.length);
    return '/' + base;
  }
  return '/' + noExt;
}

function normalizeRoutePath(p: string): string {
  return p.replace(/\/+/, '/').replace(/\/$/, '') || '/';
}

async function walkFiles(dirUrl: URL, acc: URL[] = []): Promise<URL[]> {
  const entries = await readdir(dirUrl, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childUrl = new URL(
      entry.name + (entry.isDirectory() ? '/' : ''),
      dirUrl,
    );
    if (entry.isDirectory()) {
      acc = await walkFiles(childUrl, acc);
    } else if (
      /(\.ts|\.js)$/.test(entry.name) &&
      !entry.name.endsWith('.d.ts')
    ) {
      acc.push(childUrl);
    }
  }
  return acc;
}

export async function loadRoutes(app: Express, routesDirUrl: URL) {
  try {
    await stat(routesDirUrl);
  } catch (e) {
    console.warn('Routes directory not found:', routesDirUrl.toString());
    return;
  }

  const files = await walkFiles(routesDirUrl);

  for (const fileUrl of files) {
    const rel = fileUrl.toString().slice(routesDirUrl.toString().length);
    const routePath = normalizeRoutePath(routePathFromFile(rel));

    const mod: any = await import(fileUrl.toString());
    const router = mod.default;

    if (router && typeof router === 'function') {
      if (
        routePath.startsWith('/admin') ||
        routePath.startsWith('/moderator')
      ) {
        app.use(routePath, adminLimiter, router as ReturnType<typeof Router>);
      } else if (
        routePath !== '/health' &&
        routePath !== '/docs' &&
        !routePath.startsWith('/users')
      ) {
        app.use(routePath, apiLimiter, router as ReturnType<typeof Router>);
      } else {
        app.use(routePath, router as ReturnType<typeof Router>);
      }
      console.log(`Mounted ${fileUrl.pathname} -> ${routePath}`);
    } else if (typeof mod.register === 'function') {
      mod.register(app, routePath);
      console.log(
        `Registered via register(): ${fileUrl.pathname} -> ${routePath}`,
      );
    } else {
      console.warn(
        `Skipped ${fileUrl.pathname}: no default Router or register(app, route) export`,
      );
    }
  }
}
