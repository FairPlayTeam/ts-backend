export type RequestPasswordResetInput = {
  email: string;
};

export type ResetPasswordInput = {
  email: string;
  code: string;
  password: string;
};

export type AuthPasswordResetPort = {
  requestPasswordReset: (input: RequestPasswordResetInput) => Promise<{ message: string }>;
  resetPassword: (
    input: ResetPasswordInput,
  ) => Promise<{ message: string; sessionsLoggedOut: number }>;
};
