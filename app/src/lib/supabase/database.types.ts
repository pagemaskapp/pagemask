/**
 * Espelho em TypeScript de `supabase/migrations/`.
 *
 * A partir da Fase 1, com o projeto Supabase no ar, este arquivo pode ser
 * regerado com:
 *
 *   npx supabase gen types typescript --project-id <ref> --schema public \
 *     > src/lib/supabase/database.types.ts
 *
 * Uma diferenca proposital em relacao ao gerador: `ig_accounts.Row` **nao tem**
 * `token_cipher`, `token_iv` nem `token_tag`. O papel `authenticated` nao tem
 * privilegio de leitura nessas colunas (ver os GRANTs por coluna em
 * `0001_init.sql`), entao elas nunca chegam ao cliente — e o tipo diz isso.
 * O worker, que decifra o token, e Python e nao usa este arquivo.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type JobStatus =
  | "queued"
  | "processing"
  | "done"
  | "failed"
  | "rejected"
  | "canceled";

export type ScheduleStatus =
  | "scheduled"
  | "publishing"
  | "published"
  | "failed"
  | "deferred";

export type IgAccountStatus = "active" | "needs_reconnect" | "revoked";

export type AssetKind = "header" | "logo" | "font";

export type WebhookProvider = "stripe" | "meta";

export type DataRequestKind = "deletion" | "export";

export type DataRequestStatus =
  | "received"
  | "processing"
  | "completed"
  | "failed";

export type Database = {
  public: {
    Tables: {
      plans: {
        Row: {
          slug: string;
          name: string;
          price_cents: number;
          videos_month: number;
          ig_accounts: number;
          projects: number;
          max_mb: number;
          stripe_price_id: string | null;
          active: boolean;
          sort_order: number;
          created_at: string;
        };
        Insert: {
          slug: string;
          name: string;
          price_cents: number;
          videos_month: number;
          ig_accounts: number;
          projects: number;
          max_mb: number;
          stripe_price_id?: string | null;
          active?: boolean;
          sort_order?: number;
          created_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["plans"]["Insert"]>;
      };
      profiles: {
        Row: {
          id: string;
          name: string | null;
          plan_slug: string;
          stripe_customer_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          name?: string | null;
          plan_slug?: string;
          stripe_customer_id?: string | null;
        };
        Update: {
          name?: string | null;
          plan_slug?: string;
          stripe_customer_id?: string | null;
        };
      };
      subscriptions: {
        Row: {
          id: string;
          user_id: string;
          stripe_subscription_id: string | null;
          status: string;
          current_period_end: string | null;
          videos_used: number;
          cancel_at_period_end: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_subscription_id?: string | null;
          status?: string;
          current_period_end?: string | null;
          videos_used?: number;
          cancel_at_period_end?: boolean;
        };
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Insert"]>;
      };
      templates: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          config: Json;
          version: number;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          config?: Json;
          version?: number;
        };
        Update: Partial<Database["public"]["Tables"]["templates"]["Insert"]>;
      };
      projects: {
        Row: {
          id: string;
          user_id: string;
          name: string;
          template_id: string | null;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          name: string;
          template_id?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["projects"]["Insert"]>;
      };
      assets: {
        Row: {
          id: string;
          user_id: string;
          kind: AssetKind;
          r2_key: string;
          mime: string;
          bytes: number;
          sha256: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          kind: AssetKind;
          r2_key: string;
          mime: string;
          bytes: number;
          sha256?: string | null;
        };
        Update: Partial<Database["public"]["Tables"]["assets"]["Insert"]>;
      };
      jobs: {
        Row: {
          id: string;
          project_id: string;
          user_id: string;
          status: JobStatus;
          progress: number;
          r2_input_key: string;
          r2_output_key: string | null;
          bytes_in: number | null;
          probe: Json | null;
          template_snapshot: Json | null;
          report: Json | null;
          attempts: number;
          error: string | null;
          queued_at: string;
          started_at: string | null;
          finished_at: string | null;
          expires_at: string;
        };
        Insert: {
          id?: string;
          project_id: string;
          user_id: string;
          status?: JobStatus;
          progress?: number;
          r2_input_key: string;
          r2_output_key?: string | null;
          bytes_in?: number | null;
          probe?: Json | null;
          template_snapshot?: Json | null;
          report?: Json | null;
          attempts?: number;
          error?: string | null;
          expires_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["jobs"]["Insert"]>;
      };
      ig_accounts: {
        // `Row` e a leitura, e leitura aqui e sempre do cliente: sem nenhuma
        // coluna de token, igual ao GRANT por coluna da migration.
        Row: {
          id: string;
          user_id: string;
          ig_user_id: string;
          username: string;
          profile_picture_url: string | null;
          scopes: string[];
          token_expires_at: string | null;
          last_refreshed_at: string | null;
          status: IgAccountStatus;
          connected_at: string;
        };
        // Escrita, ao contrario, e sempre do servidor — e o servidor precisa
        // gravar o token cifrado. Por isso `Insert`/`Update` tem os campos que
        // o `Row` nao tem: quem escreve e o `createAdminClient()`, no callback
        // do OAuth e na renovacao (Fase 4). O cliente nao tem privilegio de
        // insert nem de update nesta tabela.
        Insert: {
          id?: string;
          user_id: string;
          ig_user_id: string;
          username: string;
          profile_picture_url?: string | null;
          scopes?: string[];
          token_cipher?: string | null;
          token_iv?: string | null;
          token_tag?: string | null;
          key_version?: number;
          token_expires_at?: string | null;
          last_refreshed_at?: string | null;
          status?: IgAccountStatus;
        };
        Update: Partial<
          Database["public"]["Tables"]["ig_accounts"]["Insert"]
        >;
      };
      schedules: {
        Row: {
          id: string;
          job_id: string;
          ig_account_id: string;
          scheduled_at: string;
          caption: string | null;
          status: ScheduleStatus;
          ig_container_id: string | null;
          ig_media_id: string | null;
          error: string | null;
          attempts: number;
          published_at: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          job_id: string;
          ig_account_id: string;
          scheduled_at: string;
          caption?: string | null;
        };
        Update: {
          scheduled_at?: string;
          caption?: string | null;
        };
      };
      webhook_events: {
        Row: {
          id: string;
          provider: WebhookProvider;
          event_id: string;
          payload: Json;
          received_at: string;
          processed_at: string | null;
          error: string | null;
        };
        Insert: {
          id?: string;
          provider: WebhookProvider;
          event_id: string;
          payload: Json;
        };
        Update: {
          processed_at?: string | null;
          error?: string | null;
        };
      };
      audit_log: {
        Row: {
          id: string;
          user_id: string | null;
          actor: string;
          action: string;
          target: string | null;
          meta: Json;
          ip: string | null;
          created_at: string;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          actor?: string;
          action: string;
          target?: string | null;
          meta?: Json;
          ip?: string | null;
        };
        // Trilha de auditoria nao se edita — nem pelo servidor.
        Update: never;
      };
      data_requests: {
        Row: {
          id: string;
          user_id: string | null;
          kind: DataRequestKind;
          confirmation_code: string;
          status: DataRequestStatus;
          requested_at: string;
          completed_at: string | null;
          meta: Json;
        };
        Insert: {
          id?: string;
          user_id?: string | null;
          kind: DataRequestKind;
          confirmation_code: string;
          meta?: Json;
        };
        Update: {
          status?: DataRequestStatus;
          completed_at?: string | null;
          meta?: Json;
        };
      };
    };
    Views: Record<string, never>;
    Functions: Record<string, never>;
    Enums: {
      job_status: JobStatus;
      schedule_status: ScheduleStatus;
      ig_account_status: IgAccountStatus;
      asset_kind: AssetKind;
      webhook_provider: WebhookProvider;
      data_request_kind: DataRequestKind;
      data_request_status: DataRequestStatus;
    };
    CompositeTypes: Record<string, never>;
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type Plan = Tables<"plans">;
export type Profile = Tables<"profiles">;
/** Conta do Instagram como o cliente a ve: sem nenhum campo de token. */
export type IgAccountPublic = Tables<"ig_accounts">;
