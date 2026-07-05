import { MailerConfigurationError, MailerDeliveryError } from './mailer.errors.js';

const isExpectedMailerError = (
  err: unknown,
): err is MailerConfigurationError | MailerDeliveryError =>
  err instanceof MailerConfigurationError || err instanceof MailerDeliveryError;

type ExpectedMailerErrorHandlerOptions = {
  err: unknown;
  logger: {
    warn(data: object, message: string): void;
  };
  warningMessage: string;
  cleanup?: {
    run(): Promise<unknown>;
    warningMessage: string;
  };
};

export const handleExpectedMailerError = async ({
  err,
  logger,
  warningMessage,
  cleanup,
}: ExpectedMailerErrorHandlerOptions): Promise<void> => {
  if (!isExpectedMailerError(err)) {
    throw err;
  }

  logger.warn({ err }, warningMessage);

  if (!cleanup) {
    return;
  }

  await cleanup.run().catch((cleanupError: unknown) => {
    logger.warn({ cleanupError }, cleanup.warningMessage);
  });
};
