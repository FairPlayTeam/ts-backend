export type RouteDoc = {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
  summary: string;
  description?: string;
  auth?: boolean;
  roles?: string[];
  query?: Record<string, string>;
  params?: Record<string, string>;
  body?: Record<string, string>;
  responses?: Record<string, string>;
};

const registry: RouteDoc[] = [];

export const registerRoute = (doc: RouteDoc) => {
  registry.push(doc);
};

export const getDocs = () => registry.slice();
