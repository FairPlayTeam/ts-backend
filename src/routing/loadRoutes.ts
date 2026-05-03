import type { Express, Router as ExpressRouter } from 'express';
import { readdir, stat } from 'node:fs/promises';

type RouteRegister = (app: Express, routePath: string) => void | Promise<void>;

type RouteModule = {
  default?: unknown;
  register?: RouteRegister;
};

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

function normalizeRoutePath(path: string): string {
  return path.replace(/\/+/g, '/').replace(/\/$/, '') || '/';
}

async function walkFiles(dirUrl: URL, acc: URL[] = []): Promise<URL[]> {
  const entries = await readdir(dirUrl, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue;
    const childUrl = new URL(entry.name + (entry.isDirectory() ? '/' : ''), dirUrl);
    if (entry.isDirectory()) {
      acc = await walkFiles(childUrl, acc);
    } else if (/(\.ts|\.js)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
      acc.push(childUrl);
    }
  }

  return acc;
}

async function loadRoutes(app: Express, routesDirUrl: URL) {
  try {
    await stat(routesDirUrl);
  } catch {
    console.warn('Routes directory not found:', routesDirUrl.toString());
    return;
  }

  const files = (await walkFiles(routesDirUrl)).sort((left, right) =>
    left.pathname.localeCompare(right.pathname),
  );

  for (const fileUrl of files) {
    const rel = fileUrl.toString().slice(routesDirUrl.toString().length);
    const routePath = normalizeRoutePath(routePathFromFile(rel));

    const mod = (await import(fileUrl.toString())) as RouteModule;
    const router = mod.default;

    if (router && typeof router === 'function') {
      app.use(routePath, router as ExpressRouter);
      console.log(`Mounted ${fileUrl.pathname} -> ${routePath}`);
    } else if (typeof mod.register === 'function') {
      await mod.register(app, routePath);
      console.log(`Registered via register(): ${fileUrl.pathname} -> ${routePath}`);
    } else {
      console.warn(`Skipped ${fileUrl.pathname}: no default Router or register(app, route) export`);
    }
  }
}

export default loadRoutes;
