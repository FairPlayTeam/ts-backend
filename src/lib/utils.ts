export const isUUID = (str: string): boolean => {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    str,
  );
};

export const createUserSearchWhere = (identifier: string) => {
  return isUUID(identifier)
    ? { OR: [{ username: identifier }, { id: identifier }] }
    : { username: identifier };
};
