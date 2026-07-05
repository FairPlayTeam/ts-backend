export const SMTP_TLS_MODES = ['implicit', 'starttls', 'none'] as const;

export type SmtpTlsMode = (typeof SMTP_TLS_MODES)[number];

export type MailerConfig = {
  smtpHost: string;
  smtpPort: number;
  smtpTlsMode: SmtpTlsMode;
  operationTimeoutMs: number;
  smtpUser: string;
  smtpPass: string;
  smtpFrom: string;
};

export type TransactionalEmailContent = {
  title: string;
  intro: string;
  actionCode: string;
  expiryLabel: string;
  footerText: string;
};

export type NoticeEmailContent = {
  title: string;
  intro: string;
  detailsLabel: string;
  details: string;
  footerText: string;
};
