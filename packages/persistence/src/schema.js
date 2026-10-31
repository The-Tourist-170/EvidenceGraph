import {
  bigserial,
  boolean,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const users = pgTable("user", {
  id: text("id").primaryKey(),
  name: text("name").notNull(),
  email: text("email").notNull().unique(),
  emailVerified: boolean("email_verified").notNull().default(false),
  image: text("image"),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
});

export const sessions = pgTable(
  "session",
  {
    id: text("id").primaryKey(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    token: text("token").notNull().unique(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    ipAddress: text("ip_address"),
    userAgent: text("user_agent"),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
  },
  (table) => ({ userIndex: index("session_user_id_idx").on(table.userId) }),
);

export const accounts = pgTable(
  "account",
  {
    id: text("id").primaryKey(),
    accountId: text("account_id").notNull(),
    providerId: text("provider_id").notNull(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    accessToken: text("access_token"),
    refreshToken: text("refresh_token"),
    idToken: text("id_token"),
    accessTokenExpiresAt: timestamp("access_token_expires_at", {
      withTimezone: true,
    }),
    refreshTokenExpiresAt: timestamp("refresh_token_expires_at", {
      withTimezone: true,
    }),
    scope: text("scope"),
    password: text("password"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({ userIndex: index("account_user_id_idx").on(table.userId) }),
);

export const verifications = pgTable(
  "verification",
  {
    id: text("id").primaryKey(),
    identifier: text("identifier").notNull(),
    value: text("value").notNull(),
    expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    identifierIndex: index("verification_identifier_idx").on(table.identifier),
  }),
);

export const workspaces = pgTable(
  "workspaces",
  {
    id: text("id").primaryKey(),
    name: text("name").notNull(),
    slug: text("slug").notNull().unique(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    creatorIndex: index("workspaces_created_by_idx").on(table.createdBy),
  }),
);

export const workspaceMembers = pgTable(
  "workspace_members",
  {
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id, { onDelete: "cascade" }),
    role: text("role").notNull().default("member"),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    pk: primaryKey({ columns: [table.workspaceId, table.userId] }),
    userIndex: index("workspace_members_user_id_idx").on(table.userId),
  }),
);

export const researchTasks = pgTable(
  "research_tasks",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    question: text("question").notNull(),
    config: jsonb("config").notNull(),
    status: text("status").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
    fingerprint: text("fingerprint").notNull(),
    initializing: boolean("initializing").notNull().default(false),
    flushing: boolean("flushing").notNull().default(false),
    cancellationRequested: boolean("cancellation_requested")
      .notNull()
      .default(false),
    executionId: uuid("execution_id"),
    retryOf: uuid("retry_of").references(() => researchTasks.id),
    result: jsonb("result"),
    idempotencyKeyName: text("idempotency_key_name"),
  },
  (table) => ({
    ownerCreatedIndex: index("research_tasks_owner_created_idx").on(
      table.userId,
      table.workspaceId,
      table.createdAt,
    ),
    workspaceStatusIndex: index("research_tasks_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export const taskEvents = pgTable(
  "task_events",
  {
    id: bigserial("id", { mode: "number" }).primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    eventId: integer("event_id").notNull(),
    type: text("type").notNull(),
    payload: jsonb("payload").notNull(),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    taskEventUnique: uniqueIndex("task_events_task_event_unique").on(
      table.taskId,
      table.eventId,
    ),
    taskIndex: index("task_events_task_id_idx").on(table.taskId, table.eventId),
  }),
);

export const idempotencyKeys = pgTable("idempotency_keys", {
  keyName: text("key_name").primaryKey(),
  resourceType: text("resource_type").notNull(),
  fingerprint: text("fingerprint").notNull(),
  resourceId: uuid("resource_id").notNull(),
  userId: text("user_id")
    .notNull()
    .references(() => users.id),
  workspaceId: text("workspace_id")
    .notNull()
    .references(() => workspaces.id),
  state: text("state").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true })
    .notNull()
    .defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    filename: text("filename").notNull(),
    mediaType: text("media_type").notNull(),
    size: integer("size").notNull(),
    status: text("status").notNull(),
    objectKey: text("object_key").notNull().unique(),
    fingerprint: text("fingerprint").notNull(),
    idempotencyKeyName: text("idempotency_key_name"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull(),
  },
  (table) => ({
    ownerCreatedIndex: index("documents_owner_created_idx").on(
      table.userId,
      table.workspaceId,
      table.createdAt,
    ),
    workspaceStatusIndex: index("documents_workspace_status_idx").on(
      table.workspaceId,
      table.status,
    ),
  }),
);

export const documentChunks = pgTable(
  "document_chunks",
  {
    id: uuid("id").primaryKey(),
    documentId: uuid("document_id")
      .notNull()
      .references(() => documents.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    chunkUnique: uniqueIndex("document_chunks_document_index_unique").on(
      table.documentId,
      table.chunkIndex,
    ),
  }),
);

export const sources = pgTable(
  "sources",
  {
    id: uuid("id").primaryKey(),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    documentId: uuid("document_id").references(() => documents.id, {
      onDelete: "set null",
    }),
    uri: text("uri").notNull(),
    title: text("title").notNull(),
    sourceType: text("source_type").notNull(),
    metadata: jsonb("metadata").notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    workspaceIndex: index("sources_workspace_created_idx").on(
      table.workspaceId,
      table.createdAt,
    ),
  }),
);

export const reports = pgTable(
  "reports",
  {
    id: uuid("id").primaryKey(),
    taskId: uuid("task_id")
      .notNull()
      .references(() => researchTasks.id, { onDelete: "cascade" }),
    userId: text("user_id")
      .notNull()
      .references(() => users.id),
    workspaceId: text("workspace_id")
      .notNull()
      .references(() => workspaces.id),
    title: text("title").notNull(),
    currentRevision: integer("current_revision").notNull().default(1),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    taskIndex: uniqueIndex("reports_task_id_unique").on(table.taskId),
  }),
);

export const reportRevisions = pgTable(
  "report_revisions",
  {
    id: uuid("id").primaryKey(),
    reportId: uuid("report_id")
      .notNull()
      .references(() => reports.id, { onDelete: "cascade" }),
    revision: integer("revision").notNull(),
    body: jsonb("body").notNull(),
    createdBy: text("created_by")
      .notNull()
      .references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true })
      .notNull()
      .defaultNow(),
  },
  (table) => ({
    revisionUnique: uniqueIndex("report_revisions_report_revision_unique").on(
      table.reportId,
      table.revision,
    ),
  }),
);
