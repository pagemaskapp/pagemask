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
 *
 * ATENCAO ao editar: este tipo precisa satisfazer o `GenericSchema` do
 * postgrest-js — toda tabela com `Row`, `Insert`, `Update` **e
 * `Relationships`**, e conjunto vazio escrito como `{ [_ in never]: never }`,
 * nunca `Record<string, never>`.
 *
 * Se um detalhe desses faltar, nao aparece erro nenhum aqui: o esquema inteiro
 * degrada para `never` em silencio e o erro brota longe, como "Property 'x'
 * does not exist on type 'never'" em cada `.from()` e `.rpc()` do projeto.
 * Uma tabela sem `Relationships` ja custou uma tarde.
 */

export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export type JobStatus =
  // `uploaded` (migration 0006) e o estado de quem subiu e ainda nao foi
  // mandado para a fila. Vem antes de `queued` aqui pela mesma razao que vem
  // antes no enum do Postgres: e a ordem do ciclo de vida.
  | "uploaded"
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
        Relationships: [];
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
        Relationships: [
          {
            foreignKeyName: "profiles_plan_slug_fkey";
            columns: ["plan_slug"];
            isOneToOne: false;
            referencedRelation: "plans";
            referencedColumns: ["slug"];
          },
        ];
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
        Relationships: [];
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
        Relationships: [];
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
        Relationships: [
          {
            foreignKeyName: "projects_template_id_fkey";
            columns: ["template_id"];
            isOneToOne: false;
            referencedRelation: "templates";
            referencedColumns: ["id"];
          },
        ];
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
        Relationships: [];
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
          filename: string | null;
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
          filename?: string | null;
          expires_at?: string;
        };
        Update: Partial<Database["public"]["Tables"]["jobs"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "jobs_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
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
        Relationships: [];
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
        Relationships: [
          {
            foreignKeyName: "schedules_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "schedules_ig_account_id_fkey";
            columns: ["ig_account_id"];
            isOneToOne: false;
            referencedRelation: "ig_accounts";
            referencedColumns: ["id"];
          },
        ];
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
        Relationships: [];
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
        Relationships: [];
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
        Relationships: [];
      };
    };
    // Forma que o `supabase gen types` emite para conjunto vazio.
    // `Record<string, never>` NAO serve: nao satisfaz o GenericSchema do
    // postgrest-js, e o tipo inteiro degrada para `never` sem erro nenhum
    // no arquivo — o erro aparece longe, em cada `.from()` e `.rpc()`.
    Views: { [_ in never]: never };
    Functions: {
      consume_rate_limit: {
        Args: {
          p_bucket: string;
          /** Tentativas permitidas na janela. */
          p_limite: number;
          /** Intervalo do Postgres, ex.: "15 minutes". */
          p_janela: string;
        };
        Returns: {
          permitido: boolean;
          restantes: number;
          liberado_em: string;
        }[];
      };
      create_project: {
        Args: { p_name: string };
        Returns: Database["public"]["Tables"]["projects"]["Row"];
      };
      /**
       * O unico caminho para uma linha nova em `jobs` (0007). O cliente perdeu
       * o INSERT direto na tabela — e, desde a 0008, tambem perdeu o EXECUTE
       * desta funcao: ela so roda com a chave `service_role`, e o dono chega
       * por `p_user_id` em vez de `auth.uid()`.
       */
      register_upload_job: {
        Args: {
          p_user_id: string;
          p_project_id: string;
          p_r2_key: string;
          p_bytes: number;
          p_filename: string;
          p_probe: Json;
          p_recusa?: string | null;
        };
        Returns: Database["public"]["Tables"]["jobs"]["Row"];
      };
      /**
       * Devolve as chaves do R2 para o servidor apagar depois. `service_role`
       * so, pela mesma razao da `register_upload_job`: sem o passo do servidor,
       * a linha some e o arquivo fica.
       */
      discard_job: {
        Args: { p_user_id: string; p_job_id: string };
        Returns: { input_key: string; output_key: string | null }[];
      };
      discard_project: {
        Args: { p_user_id: string; p_project_id: string };
        Returns: { chave: string }[];
      };
    };
    Enums: {
      job_status: JobStatus;
      schedule_status: ScheduleStatus;
      ig_account_status: IgAccountStatus;
      asset_kind: AssetKind;
      webhook_provider: WebhookProvider;
      data_request_kind: DataRequestKind;
      data_request_status: DataRequestStatus;
    };
    CompositeTypes: { [_ in never]: never };
  };
};

export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

export type Plan = Tables<"plans">;
export type Profile = Tables<"profiles">;
/** Conta do Instagram como o cliente a ve: sem nenhum campo de token. */
export type IgAccountPublic = Tables<"ig_accounts">;
