/**
 * Expenso database schema (PostgreSQL). Mirrors SRS RRX-TER-SRS-001 v2.0 §3.
 * Money is stored as integer paise (bigint) to keep every total exact.
 * Timestamps are UTC (timestamptz); calendar dates (locations, payments) are IST dates.
 */
import { sql } from 'drizzle-orm';
import {
  bigint, bigserial, boolean, date, doublePrecision, index, integer, jsonb, pgEnum, pgTable, text, timestamp, uniqueIndex, uuid,
} from 'drizzle-orm/pg-core';

const ts = (name: string) => timestamp(name, { withTimezone: true, mode: 'date' });
const paise = (name: string) => bigint(name, { mode: 'number' });

/* ---------------- enums ---------------- */
export const tripTypeEnum = pgEnum('trip_type', ['same_day', 'multi_day']);
export const tripPurposeEnum = pgEnum('trip_purpose', ['client_meeting', 'conference', 'training', 'audit', 'installation', 'other']);
export const tripStatusEnum = pgEnum('trip_status', ['scheduled', 'active', 'extended', 'closed', 'cancelled']);
export const memberRoleEnum = pgEnum('member_role', ['owner', 'member']);
export const joinStatusEnum = pgEnum('join_status', ['invited', 'accepted', 'declined', 'withdrawn', 'expired']);
export const startMethodEnum = pgEnum('start_method', ['manual', 'automatic']);
export const endMethodEnum = pgEnum('end_method', ['member', 'finance']);
export const claimStatusEnum = pgEnum('claim_status', ['open', 'ready', 'verified', 'part_paid', 'reimbursed']);
export const categoryEnum = pgEnum('expense_category', [
  'airfare', 'train', 'cab', 'fuel_toll', 'accommodation', 'meals', 'client_entertainment',
  'event_fee', 'printing', 'courier', 'internet_phone', 'visa_passport', 'other',
]);
export const paymentModeEnum = pgEnum('payment_mode', ['upi', 'cash', 'card', 'company']);
export const paidByEnum = pgEnum('paid_by', ['self', 'company']);
export const budgetSourceEnum = pgEnum('budget_source', ['pool', 'individual', 'unbudgeted']);
export const verificationEnum = pgEnum('verification', ['pending', 'verified', 'query', 'rejected']);
export const budgetTypeEnum = pgEnum('budget_type', ['pool', 'individual']);
export const attachmentKindEnum = pgEnum('attachment_kind', ['receipt', 'document']);
export const docTypeEnum = pgEnum('doc_type', ['payment_proof', 'invoice', 'approval_note', 'bank_statement', 'other']);
export const docScopeEnum = pgEnum('doc_scope', ['trip', 'claim', 'expense']);
export const uploadStatusEnum = pgEnum('upload_status', ['pending', 'uploaded']);
export const reimbursementModeEnum = pgEnum('reimbursement_mode', ['bank_transfer', 'upi', 'cash']);
export const exportScopeEnum = pgEnum('export_scope', ['trip', 'member', 'each', 'trip_and_each']);
export const exportStatusEnum = pgEnum('export_status', ['queued', 'building', 'ready', 'failed']);
export const messageKindEnum = pgEnum('message_kind', ['query', 'reply', 'reject', 'note', 'dispute']);

/* ---------------- people ---------------- */
export const departments = pgTable('departments', {
  id: uuid('id').primaryKey().defaultRandom(),
  name: text('name').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  archivedAt: ts('archived_at'),
}, t => [uniqueIndex('departments_name_uq').on(sql`lower(${t.name})`)]);

export const users = pgTable('users', {
  id: uuid('id').primaryKey().defaultRandom(),
  employeeCode: text('employee_code').notNull(),
  name: text('name').notNull(),
  email: text('email').notNull(),
  phone: text('phone'),
  designation: text('designation'),
  departmentId: uuid('department_id').notNull().references(() => departments.id),
  isFinance: boolean('is_finance').notNull().default(false),
  isAdmin: boolean('is_admin').notNull().default(false),
  passwordHash: text('password_hash'),
  active: boolean('active').notNull().default(true),
  deactivatedAt: ts('deactivated_at'),
  failedLogins: integer('failed_logins').notNull().default(0),
  lockedUntil: ts('locked_until'),
  firstMobileLoginAt: ts('first_mobile_login_at'),
  lastSeenAt: ts('last_seen_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('users_email_uq').on(sql`lower(${t.email})`),
  uniqueIndex('users_code_uq').on(t.employeeCode),
  index('users_department_idx').on(t.departmentId),
]);

export const refreshTokens = pgTable('refresh_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  tokenHash: text('token_hash').notNull(),
  client: text('client').notNull(), // 'mobile' | 'web'
  deviceLabel: text('device_label'),
  createdAt: ts('created_at').notNull().defaultNow(),
  lastUsedAt: ts('last_used_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  revokedAt: ts('revoked_at'),
}, t => [uniqueIndex('refresh_tokens_hash_uq').on(t.tokenHash), index('refresh_tokens_user_idx').on(t.userId)]);

export const otpCodes = pgTable('otp_codes', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  codeHash: text('code_hash').notNull(),
  attempts: integer('attempts').notNull().default(0),
  createdAt: ts('created_at').notNull().defaultNow(),
  expiresAt: ts('expires_at').notNull(),
  usedAt: ts('used_at'),
}, t => [index('otp_codes_user_idx').on(t.userId)]);

export const deviceTokens = pgTable('device_tokens', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  platform: text('platform').notNull(), // android | ios | web
  token: text('token').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [uniqueIndex('device_tokens_token_uq').on(t.token)]);

export const userSettings = pgTable('user_settings', {
  userId: uuid('user_id').primaryKey().references(() => users.id),
  dailyDigest: boolean('daily_digest').notNull().default(false),
  theme: text('theme').notNull().default('system'),
  notificationPrefs: jsonb('notification_prefs').notNull().default({}),
  lastDigestOn: date('last_digest_on', { mode: 'string' }),
  updatedAt: ts('updated_at').notNull().defaultNow(),
});

/* ---------------- trips ---------------- */
export const refCounters = pgTable('ref_counters', {
  year: integer('year').primaryKey(),
  last: integer('last').notNull().default(0),
});

export const trips = pgTable('trips', {
  id: uuid('id').primaryKey().defaultRandom(),
  ref: text('ref').notNull(),
  clientId: text('client_id'),
  name: text('name').notNull(),
  type: tripTypeEnum('type').notNull(),
  purpose: tripPurposeEnum('purpose').notNull(),
  clientEvent: text('client_event'),
  departmentId: uuid('department_id').notNull().references(() => departments.id),
  ownerId: uuid('owner_id').notNull().references(() => users.id),
  scheduledStart: ts('scheduled_start').notNull(),
  tentativeEnd: ts('tentative_end').notNull(),
  primaryCity: text('primary_city').notNull(),
  notes: text('notes'),
  status: tripStatusEnum('status').notNull().default('scheduled'),
  enteredAfterStart: boolean('entered_after_start').notNull().default(false),
  createdOffline: boolean('created_offline').notNull().default(false),
  copiedFrom: uuid('copied_from'),
  firstStartAt: ts('first_start_at'),
  extendedAt: ts('extended_at'),
  closedAt: ts('closed_at'),
  cancelledAt: ts('cancelled_at'),
  cancelledBy: uuid('cancelled_by').references(() => users.id),
  cancelReason: text('cancel_reason'),
  version: integer('version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('trips_ref_uq').on(t.ref),
  uniqueIndex('trips_client_uq').on(t.ownerId, t.clientId),
  index('trips_status_idx').on(t.status),
  index('trips_department_idx').on(t.departmentId),
  index('trips_start_idx').on(t.scheduledStart),
]);

export const tripMembers = pgTable('trip_members', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  role: memberRoleEnum('role').notNull().default('member'),
  joinStatus: joinStatusEnum('join_status').notNull().default('invited'),
  invitedBy: uuid('invited_by').references(() => users.id),
  invitedAt: ts('invited_at').notNull().defaultNow(),
  respondedAt: ts('responded_at'),
  inviteRemindedAt: ts('invite_reminded_at'),
  actualStart: ts('actual_start'),
  startMethod: startMethodEnum('start_method'),
  startDeviceTime: ts('start_device_time'),
  startReceivedAt: ts('start_received_at'),
  startBackdated: boolean('start_backdated').notNull().default(false),
  actualEnd: ts('actual_end'),
  endMethod: endMethodEnum('end_method'),
  endReason: text('end_reason'),
  endedBy: uuid('ended_by').references(() => users.id),
  endDeviceTime: ts('end_device_time'),
  endReceivedAt: ts('end_received_at'),
  extensionPromptedAt: ts('extension_prompted_at'),
  lastReminderAt: ts('last_reminder_at'),
  claimStatus: claimStatusEnum('claim_status').notNull().default('open'),
  claimStatusAt: ts('claim_status_at').notNull().defaultNow(),
  reopenedAt: ts('reopened_at'),
  reopenReason: text('reopen_reason'),
  reopenedBy: uuid('reopened_by').references(() => users.id),
  leftAt: ts('left_at'),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
}, t => [
  uniqueIndex('trip_members_uq').on(t.tripId, t.userId),
  index('trip_members_user_idx').on(t.userId),
]);

export const locations = pgTable('locations', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  clientId: text('client_id'),
  city: text('city').notNull(),
  venue: text('venue'),
  address: text('address'),
  lat: doublePrecision('lat'),
  lng: doublePrecision('lng'),
  arrivalDate: date('arrival_date', { mode: 'string' }).notNull(),
  departureDate: date('departure_date', { mode: 'string' }).notNull(),
  notes: text('notes'),
  isPrimary: boolean('is_primary').notNull().default(false),
  addedBy: uuid('added_by').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, t => [index('locations_trip_idx').on(t.tripId), uniqueIndex('locations_client_uq').on(t.tripId, t.clientId)]);

/* ---------------- money ---------------- */
export const budgets = pgTable('budgets', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  type: budgetTypeEnum('type').notNull(),
  memberUserId: uuid('member_user_id').references(() => users.id),
  amountPaise: paise('amount_paise').notNull(),
  alertLevel: integer('alert_level').notNull().default(0), // 0, 80 or 100: the highest threshold already announced
  setBy: uuid('set_by').notNull().references(() => users.id),
  setAt: ts('set_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  removedAt: ts('removed_at'),
  removedBy: uuid('removed_by').references(() => users.id),
}, t => [
  index('budgets_trip_idx').on(t.tripId),
  uniqueIndex('budgets_pool_uq').on(t.tripId).where(sql`${t.type} = 'pool' and ${t.removedAt} is null`),
  uniqueIndex('budgets_individual_uq').on(t.tripId, t.memberUserId).where(sql`${t.type} = 'individual' and ${t.removedAt} is null`),
]);

export const budgetChanges = pgTable('budget_changes', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  budgetId: uuid('budget_id').notNull().references(() => budgets.id),
  type: budgetTypeEnum('type').notNull(),
  memberUserId: uuid('member_user_id').references(() => users.id),
  oldPaise: paise('old_paise'),
  newPaise: paise('new_paise'),
  note: text('note'),
  changedBy: uuid('changed_by').notNull().references(() => users.id),
  changedAt: ts('changed_at').notNull().defaultNow(),
}, t => [index('budget_changes_trip_idx').on(t.tripId)]);

export const expenses = pgTable('expenses', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id'),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  locationId: uuid('location_id').notNull().references(() => locations.id),
  userId: uuid('user_id').notNull().references(() => users.id),
  spentAt: ts('spent_at').notNull(),
  category: categoryEnum('category').notNull(),
  description: text('description').notNull(),
  amountPaise: paise('amount_paise').notNull(),
  paymentMode: paymentModeEnum('payment_mode').notNull(),
  paidBy: paidByEnum('paid_by').notNull(),
  budgetSource: budgetSourceEnum('budget_source'), // null for company-paid
  needsBudgetChoice: boolean('needs_budget_choice').notNull().default(false),
  remarks: text('remarks'),
  verification: verificationEnum('verification').notNull().default('pending'),
  approvedPaise: paise('approved_paise'),
  approvalReason: text('approval_reason'),
  financeRemark: text('finance_remark'),
  verifiedBy: uuid('verified_by').references(() => users.id),
  verifiedAt: ts('verified_at'),
  flags: text('flags').array().notNull().default(sql`'{}'::text[]`),
  deviceTime: ts('device_time'),
  receivedAt: ts('received_at').notNull().defaultNow(),
  version: integer('version').notNull().default(1),
  createdAt: ts('created_at').notNull().defaultNow(),
  updatedAt: ts('updated_at').notNull().defaultNow(),
  deletedAt: ts('deleted_at'),
}, t => [
  uniqueIndex('expenses_client_uq').on(t.userId, t.clientId),
  index('expenses_trip_idx').on(t.tripId),
  index('expenses_user_idx').on(t.userId),
  index('expenses_location_idx').on(t.locationId),
]);

export const expenseMessages = pgTable('expense_messages', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id'),
  expenseId: uuid('expense_id').notNull().references(() => expenses.id),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  authorId: uuid('author_id').notNull().references(() => users.id),
  side: text('side').notNull(), // 'member' | 'finance'
  kind: messageKindEnum('kind').notNull(),
  body: text('body').notNull(),
  createdAt: ts('created_at').notNull().defaultNow(),
}, t => [index('expense_messages_expense_idx').on(t.expenseId), uniqueIndex('expense_messages_client_uq').on(t.authorId, t.clientId)]);

export const attachments = pgTable('attachments', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id'),
  kind: attachmentKindEnum('kind').notNull(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  expenseId: uuid('expense_id').references(() => expenses.id),
  memberUserId: uuid('member_user_id').references(() => users.id), // whose claim it belongs to
  messageId: uuid('message_id').references(() => expenseMessages.id),
  docType: docTypeEnum('doc_type'),
  docScope: docScopeEnum('doc_scope'),
  visibleToMember: boolean('visible_to_member').notNull().default(true),
  storageKey: text('storage_key'),
  originalName: text('original_name').notNull(),
  note: text('note'),
  mime: text('mime').notNull(),
  sizeBytes: integer('size_bytes').notNull().default(0),
  width: integer('width'),
  height: integer('height'),
  sha256: text('sha256'),
  capturedAt: ts('captured_at'),
  status: uploadStatusEnum('status').notNull().default('pending'),
  uploadedBy: uuid('uploaded_by').notNull().references(() => users.id),
  createdAt: ts('created_at').notNull().defaultNow(),
  uploadedAt: ts('uploaded_at'),
  deletedAt: ts('deleted_at'),
  deletedBy: uuid('deleted_by').references(() => users.id),
}, t => [
  index('attachments_expense_idx').on(t.expenseId),
  index('attachments_trip_idx').on(t.tripId),
  uniqueIndex('attachments_client_uq').on(t.uploadedBy, t.clientId),
]);

export const payments = pgTable('payments', {
  id: uuid('id').primaryKey().defaultRandom(),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  memberUserId: uuid('member_user_id').notNull().references(() => users.id),
  amountPaise: paise('amount_paise').notNull(),
  paidOn: date('paid_on', { mode: 'string' }).notNull(),
  mode: reimbursementModeEnum('mode').notNull(),
  reference: text('reference'),
  proofAttachmentId: uuid('proof_attachment_id').references(() => attachments.id),
  note: text('note'),
  recordedBy: uuid('recorded_by').notNull().references(() => users.id),
  recordedAt: ts('recorded_at').notNull().defaultNow(),
}, t => [index('payments_claim_idx').on(t.tripId, t.memberUserId)]);

export const exportsTable = pgTable('exports', {
  id: uuid('id').primaryKey().defaultRandom(),
  clientId: text('client_id'),
  tripId: uuid('trip_id').notNull().references(() => trips.id),
  requestedBy: uuid('requested_by').notNull().references(() => users.id),
  requestedVia: text('requested_via').notNull().default('web'),
  scope: exportScopeEnum('scope').notNull(),
  memberUserId: uuid('member_user_id').references(() => users.id),
  formats: text('formats').array().notNull(),
  locationId: uuid('location_id').references(() => locations.id),
  dateFrom: date('date_from', { mode: 'string' }),
  dateTo: date('date_to', { mode: 'string' }),
  provisional: boolean('provisional').notNull().default(false),
  status: exportStatusEnum('status').notNull().default('queued'),
  baseName: text('base_name'),
  files: jsonb('files').notNull().default([]), // [{format, key, name, size}]
  missingReceipts: integer('missing_receipts').notNull().default(0),
  error: text('error'),
  createdAt: ts('created_at').notNull().defaultNow(),
  startedAt: ts('started_at'),
  finishedAt: ts('finished_at'),
}, t => [
  index('exports_trip_idx').on(t.tripId),
  uniqueIndex('exports_client_uq').on(t.requestedBy, t.clientId),
  index('exports_queue_idx').on(t.status, t.createdAt).where(sql`${t.status} in ('queued', 'building')`),
]);

/* ---------------- notifications and audit ---------------- */
export const notifications = pgTable('notifications', {
  id: uuid('id').primaryKey().defaultRandom(),
  userId: uuid('user_id').notNull().references(() => users.id),
  type: text('type').notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  tripId: uuid('trip_id').references(() => trips.id),
  data: jsonb('data').notNull().default({}),
  sensitive: boolean('sensitive').notNull().default(false),
  channel: text('channel').notNull().default('app'), // app | web | both
  createdAt: ts('created_at').notNull().defaultNow(),
  readAt: ts('read_at'),
  pushedAt: ts('pushed_at'),
}, t => [index('notifications_user_idx').on(t.userId, t.createdAt)]);

export const auditLog = pgTable('audit_log', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  at: ts('at').notNull().defaultNow(),
  actorId: uuid('actor_id').references(() => users.id),
  actorLabel: text('actor_label').notNull(),
  action: text('action').notNull(),
  entity: text('entity').notNull(),
  entityId: uuid('entity_id'),
  tripId: uuid('trip_id').references(() => trips.id),
  memberUserId: uuid('member_user_id').references(() => users.id),
  before: jsonb('before'),
  after: jsonb('after'),
  meta: jsonb('meta').notNull().default({}),
}, t => [
  index('audit_trip_idx').on(t.tripId, t.at),
  index('audit_actor_idx').on(t.actorId, t.at),
  index('audit_action_idx').on(t.action),
]);
