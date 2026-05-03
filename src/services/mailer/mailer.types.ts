export type MailerConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
  frontendUrl: string;
};

export type TransactionalEmailContent = {
  title: string;
  intro: string;
  actionLabel: string;
  actionUrl: string;
  expiryLabel: string;
  footerText: string;
};
