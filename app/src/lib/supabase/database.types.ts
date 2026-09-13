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

export type PreviewStatus = "queued" | "processing" | "done" | "failed";

export type ZipStatus = "queued" | "processing" | "done" | "failed";

export type AssetKind = "header" | "logo" | "font";

export type WebhookProvider = "stripe" | "meta";

/**
 * `subscriptions.payment_state` (migration 0022).
 *
 * `processando` e o Pix Automatico entre a notificacao previa e o debito
 * (ciclo + 3 dias). Nesse intervalo a Stripe mantem a assinatura `active` e o
 * acesso continua — rebaixar ali seria cortar quem esta em dia.
 */
export type PaymentState = "nenhum" | "ok" | "processando" | "falhou";

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
          /**
           * Teto de audio transcrito por periodo, em segundos (0023). Zero
           * desliga a legenda automatica naquele plano.
           */
          transcription_seconds_month: number;
          stripe_price_id: string | null;
          stripe_product_id: string | null;
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
          transcription_seconds_month?: number;
          stripe_price_id?: string | null;
          stripe_product_id?: string | null;
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
          /**
           * Conta que passa pelos gates de cobranca sem assinatura (pilotos,
           * contas internas). So a chave secreta escreve: o `grant update
           * (name)` da 0001 e a lista completa do que o dono edita.
           */
          billing_exempt: boolean;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id: string;
          name?: string | null;
          plan_slug?: string;
          stripe_customer_id?: string | null;
          billing_exempt?: boolean;
        };
        Update: {
          name?: string | null;
          plan_slug?: string;
          stripe_customer_id?: string | null;
          billing_exempt?: boolean;
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
          stripe_customer_id: string | null;
          stripe_subscription_id: string | null;
          stripe_price_id: string | null;
          /** O plano que ESTA assinatura paga, traduzido de `stripe_price_id`. */
          plan_slug: string | null;
          /** O `status` da Stripe, cru. `incomplete` para quem nunca assinou. */
          status: string;
          current_period_start: string | null;
          current_period_end: string | null;
          videos_used: number;
          /**
           * Segundos de audio transcritos no periodo (0023). Incrementa quando
           * a transcricao e AUTORIZADA, e nao e devolvida se o render falhar
           * depois: a CPU ja foi gasta. Zerada com `videos_used`.
           */
          transcription_seconds_used: number;
          cancel_at_period_end: boolean;
          cancel_at: string | null;
          canceled_at: string | null;
          /** Inicio do periodo cujo `videos_used` ja foi zerado (0022). */
          quota_period_start: string | null;
          /** O `created` do ultimo evento da Stripe aplicado ao estado (0022). */
          last_event_at: string | null;
          /** `nenhum` | `ok` | `processando` (Pix em curso) | `falhou`. */
          payment_state: PaymentState;
          created_at: string;
          updated_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          stripe_customer_id?: string | null;
          stripe_subscription_id?: string | null;
          stripe_price_id?: string | null;
          plan_slug?: string | null;
          status?: string;
          current_period_start?: string | null;
          current_period_end?: string | null;
          videos_used?: number;
          transcription_seconds_used?: number;
          cancel_at_period_end?: boolean;
          cancel_at?: string | null;
          canceled_at?: string | null;
          quota_period_start?: string | null;
          last_event_at?: string | null;
          payment_state?: PaymentState;
        };
        Update: Partial<Database["public"]["Tables"]["subscriptions"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "subscriptions_plan_slug_fkey";
            columns: ["plan_slug"];
            isOneToOne: false;
            referencedRelation: "plans";
            referencedColumns: ["slug"];
          },
        ];
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
          /**
           * A legenda deste video no R2 (0023). Preenchida na PRIMEIRA
           * transcricao e nunca mais — dali em diante o render le o arquivo em
           * vez de transcrever. Nula = este job nunca teve legenda.
           */
          r2_srt_key: string | null;
          /** Segundos de audio que a transcricao cobrou da cota (0023). */
          transcribed_seconds: number | null;
          attempts: number;
          error: string | null;
          filename: string | null;
          queued_at: string;
          started_at: string | null;
          finished_at: string | null;
          next_attempt_at: string | null;
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
          r2_srt_key?: string | null;
          transcribed_seconds?: number | null;
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
          ig_permalink: string | null;
          error: string | null;
          attempts: number;
          published_at: string | null;
          next_attempt_at: string | null;
          claimed_by: string | null;
          claimed_at: string | null;
          created_at: string;
          updated_at: string;
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
      /**
       * Nonce de uso unico do `state` do OAuth (0018). Aparece aqui por
       * completude do esquema; o app nunca a consulta pelo PostgREST — quem
       * mexe nela sao `start_ig_connect` e `consume_ig_state`, e o papel
       * `authenticated` nao tem privilegio nenhum sobre a tabela.
       */
      ig_oauth_states: {
        Row: {
          nonce: string;
          user_id: string;
          created_at: string;
          used_at: string | null;
        };
        Insert: {
          nonce: string;
          user_id: string;
          used_at?: string | null;
        };
        Update: { used_at?: string | null };
        Relationships: [];
      };
      /**
       * Fase 6 (0020) — a fila das previas do editor.
       *
       * O cliente so LE: a politica de `template_previews` nao tem insert,
       * update nem delete, e o `revoke` fecha por fora. Quem cria e a
       * `request_preview`, chamada pelo servidor depois do limite de taxa; quem
       * conclui e o worker. Por isso `Insert` e `Update` existem aqui apenas
       * para satisfazer o `GenericSchema` do postgrest-js.
       */
      template_previews: {
        Row: {
          id: string;
          user_id: string;
          project_id: string;
          job_id: string;
          config: Json;
          status: PreviewStatus;
          r2_key: string | null;
          error: string | null;
          attempts: number;
          claimed_by: string | null;
          claimed_at: string | null;
          created_at: string;
          finished_at: string | null;
          expires_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id: string;
          job_id: string;
          config: Json;
        };
        Update: Partial<
          Database["public"]["Tables"]["template_previews"]["Insert"]
        >;
        Relationships: [
          {
            foreignKeyName: "template_previews_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
          {
            foreignKeyName: "template_previews_job_id_fkey";
            columns: ["job_id"];
            isOneToOne: false;
            referencedRelation: "jobs";
            referencedColumns: ["id"];
          },
        ];
      };
      /**
       * Fase 7 (0021) — a fila do ZIP do lote.
       *
       * Mesma forma da `template_previews`: o cliente so LE. Quem cria e a
       * `request_zip`, chamada pelo servidor depois do limite de taxa; quem
       * conclui e o worker. `Insert` e `Update` existem aqui apenas para
       * satisfazer o `GenericSchema` do postgrest-js.
       */
      batch_zips: {
        Row: {
          id: string;
          user_id: string;
          project_id: string;
          status: ZipStatus;
          digest: string;
          r2_key: string | null;
          bytes: number | null;
          videos: number;
          error: string | null;
          attempts: number;
          claimed_by: string | null;
          claimed_at: string | null;
          created_at: string;
          finished_at: string | null;
          expires_at: string;
        };
        Insert: {
          id?: string;
          user_id: string;
          project_id: string;
          digest: string;
        };
        Update: Partial<Database["public"]["Tables"]["batch_zips"]["Insert"]>;
        Relationships: [
          {
            foreignKeyName: "batch_zips_project_id_fkey";
            columns: ["project_id"];
            isOneToOne: false;
            referencedRelation: "projects";
            referencedColumns: ["id"];
          },
        ];
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
      /**
       * Devolve TODAS as chaves a apagar no R2: a entrada, a saida e os
       * pacotes ZIP daquele projeto, que a remocao invalida (0021). Uma
       * coluna so, a mesma forma da `discard_project`.
       */
      discard_job: {
        Args: { p_user_id: string; p_job_id: string };
        Returns: { chave: string }[];
      };
      discard_project: {
        Args: { p_user_id: string; p_project_id: string };
        Returns: { chave: string }[];
      };
      /**
       * Fase 3 — a fila (migrations 0015 e 0017).
       *
       * Todas sao `service_role`, sem excecao, e nenhuma delas seria segura
       * exposta ao PostgREST: `claim_job` reclamaria job de qualquer usuario,
       * `finish_job` marcaria como pronto um video que ninguem processou, e
       * `fail_job` devolveria credito a vontade. Ver a migration 0015.
       */
      enqueue_project: {
        Args: {
          p_user_id: string;
          p_project_id: string;
          p_snapshot: Json;
          /** Nulo = o projeto inteiro. Com lista, so os ids dela (0020). */
          p_job_ids?: string[] | null;
        };
        /** Quantos jobs sairam de `uploaded` para `queued`. */
        Returns: number;
      };
      /**
       * Devolve uma linha de `jobs` com TODAS as colunas nulas quando nao ha
       * nada na fila — e nao zero linhas. E composto, nao conjunto.
       */
      claim_job: {
        Args: { p_worker: string; p_max_por_usuario?: number };
        Returns: Database["public"]["Tables"]["jobs"]["Row"] | null;
      };
      job_progress: {
        Args: { p_job_id: string; p_attempt: number; p_progress: number };
        Returns: boolean;
      };
      job_probe: {
        Args: { p_job_id: string; p_attempt: number; p_probe: Json };
        Returns: boolean;
      };
      finish_job: {
        Args: {
          p_job_id: string;
          p_attempt: number;
          p_output_key: string;
          p_report: Json;
          p_probe?: Json | null;
        };
        Returns: Database["public"]["Tables"]["jobs"]["Row"];
      };
      fail_job: {
        Args: {
          p_job_id: string;
          p_attempt: number;
          p_mensagem: string;
          p_definitivo?: boolean;
          p_max?: number;
          p_espera_s?: number;
        };
        Returns: Database["public"]["Tables"]["jobs"]["Row"];
      };
      reject_job: {
        Args: {
          p_job_id: string;
          p_attempt: number;
          p_mensagem: string;
          p_probe?: Json | null;
        };
        Returns: Database["public"]["Tables"]["jobs"]["Row"];
      };
      requeue_stale_jobs: {
        Args: { p_minutos?: number; p_max?: number };
        Returns: { id: string; status: JobStatus; attempts: number }[];
      };
      worker_beat: {
        Args: { p_worker: string; p_ffmpeg?: string | null; p_jobs_done?: number };
        Returns: undefined;
      };

      // --- Fase 4: conectores do Instagram (0018) ----------------------------
      // Todas so com `service_role`. Nenhuma e chamavel pelo navegador.

      start_ig_connect: {
        Args: { p_user_id: string; p_nonce: string };
        Returns: undefined;
      };
      consume_ig_state: {
        Args: { p_nonce: string; p_user_id: string; p_minutos?: number };
        Returns: boolean;
      };
      connect_ig_account: {
        Args: {
          p_user_id: string;
          p_ig_user_id: string;
          p_username: string;
          p_picture: string | null;
          p_scopes: string[];
          /** Token cifrado em HEX. Ver o cabecalho da migration 0018. */
          p_cipher_hex: string;
          p_iv_hex: string;
          p_tag_hex: string;
          p_expires_at: string;
          p_key_version?: number;
        };
        Returns: Database["public"]["Tables"]["ig_accounts"]["Row"];
      };
      disconnect_ig_account: {
        Args: { p_user_id: string; p_account_id: string };
        Returns: Database["public"]["Tables"]["ig_accounts"]["Row"];
      };
      /**
       * A UNICA porta por onde o token cifrado sai do banco — e ela e do cron.
       * `ig_accounts.Row` continua sem esses campos de proposito: o contrato do
       * cliente e o `Row`, e ele nao pode conhecer token nenhum.
       */
      ig_accounts_para_renovar: {
        Args: { p_dias?: number; p_max?: number };
        Returns: {
          id: string;
          user_id: string;
          ig_user_id: string;
          username: string;
          cipher_hex: string;
          iv_hex: string;
          tag_hex: string;
          key_version: number;
          expires_at: string;
        }[];
      };
      refresh_ig_token: {
        Args: {
          p_account_id: string;
          p_cipher_hex: string;
          p_iv_hex: string;
          p_tag_hex: string;
          p_expires_at: string;
          p_key_version?: number;
        };
        Returns: undefined;
      };
      /** `true` so quando ESTA chamada mudou o estado (ver a 0018). */
      mark_ig_needs_reconnect: {
        Args: { p_account_id: string };
        Returns: boolean;
      };

      // --- Fase 5: agenda e publicacao (0019) ---------------------------------
      // Todas so com `service_role`. `claim_publish` e `ig_account_token`
      // DEVOLVEM token cifrado; o resto decide estado a partir de um id que o
      // cliente nao tem como provar.

      /** O token de uma conta, para o app consultar `content_publishing_limit`. */
      ig_account_token: {
        Args: { p_user_id: string; p_account_id: string };
        Returns: {
          id: string;
          ig_user_id: string;
          username: string;
          status: IgAccountStatus;
          cipher_hex: string | null;
          iv_hex: string | null;
          tag_hex: string | null;
          key_version: number;
          token_expires_at: string | null;
        }[];
      };
      /** O cron de cada minuto: quantos vencidos viraram `publishing`. */
      mark_due_schedules: {
        Args: { p_max?: number };
        Returns: number;
      };
      claim_publish: {
        Args: { p_worker: string; p_stale_min?: number };
        Returns: {
          schedule_id: string;
          job_id: string;
          user_id: string;
          ig_account_id: string;
          scheduled_at: string;
          caption: string | null;
          attempts: number;
          ig_container_id: string | null;
          r2_output_key: string | null;
          filename: string | null;
          ig_user_id: string;
          username: string;
          account_status: IgAccountStatus;
          cipher_hex: string | null;
          iv_hex: string | null;
          tag_hex: string | null;
          key_version: number;
        }[];
      };
      publish_container: {
        Args: { p_id: string; p_attempt: number; p_container_id: string };
        Returns: boolean;
      };
      finish_publish: {
        Args: {
          p_id: string;
          p_attempt: number;
          p_media_id: string;
          p_permalink?: string | null;
        };
        Returns: Database["public"]["Tables"]["schedules"]["Row"];
      };
      fail_publish: {
        Args: {
          p_id: string;
          p_attempt: number;
          p_mensagem: string;
          p_definitivo?: boolean;
          p_max?: number;
          p_espera_s?: number;
          p_limpar_container?: boolean;
        };
        Returns: Database["public"]["Tables"]["schedules"]["Row"];
      };
      defer_publish: {
        Args: { p_id: string; p_attempt: number; p_ate: string; p_mensagem: string };
        Returns: Database["public"]["Tables"]["schedules"]["Row"];
      };
      /** O botao "Tentar de novo": `failed` volta para `scheduled` agora. */
      retry_schedule: {
        Args: { p_user_id: string; p_id: string };
        Returns: Database["public"]["Tables"]["schedules"]["Row"];
      };
      /** Data Deletion Request Callback da Meta. Idempotente por `p_event_id`. */
      open_meta_data_deletion: {
        Args: { p_ig_user_id: string; p_code: string; p_event_id: string };
        Returns: {
          confirmation_code: string;
          user_id: string | null;
          ja_existia: boolean;
        }[];
      };
      /** Deauthorize Callback da Meta. Contas revogadas, ou -1 se repetido. */
      deauthorize_ig: {
        Args: { p_ig_user_id: string; p_event_id: string };
        Returns: number;
      };
      data_request_status: {
        Args: { p_code: string };
        Returns: {
          kind: DataRequestKind;
          status: DataRequestStatus;
          requested_at: string;
          completed_at: string | null;
        }[];
      };

      // --- Fase 6: editor de template (0020) ---------------------------------
      // Todas so com `service_role`, pela regra da 0008: o dono vai por
      // `p_user_id` decidido no servidor, e as do worker decidem estado a
      // partir de um identificador que o cliente nao tem como provar.

      /** Cria ou atualiza. `p_id` nulo = criar. A versao e decidida no banco. */
      save_template: {
        Args: {
          p_user_id: string;
          p_id: string | null;
          p_name: string;
          p_config: Json;
        };
        Returns: Database["public"]["Tables"]["templates"]["Row"];
      };
      /**
       * `p_job_id` e SUGESTAO: so vale se o video for do mesmo projeto e do
       * mesmo dono. Sem ele, o banco escolhe o mais recente do projeto.
       */
      request_preview: {
        Args: {
          p_user_id: string;
          p_project_id: string;
          p_job_id: string | null;
          p_config: Json;
        };
        Returns: Database["public"]["Tables"]["template_previews"]["Row"];
      };
      /** Conjunto vazio quando nao ha previa na fila (nao e composto nulo). */
      claim_preview: {
        Args: { p_worker: string; p_stale_min?: number };
        Returns: {
          id: string;
          user_id: string;
          project_id: string;
          job_id: string;
          config: Json;
          attempts: number;
          expires_at: string;
          r2_input_key: string;
          bytes_in: number | null;
        }[];
      };
      finish_preview: {
        Args: { p_id: string; p_attempt: number; p_key: string };
        Returns: Database["public"]["Tables"]["template_previews"]["Row"];
      };
      fail_preview: {
        Args: { p_id: string; p_attempt: number; p_mensagem: string };
        Returns: Database["public"]["Tables"]["template_previews"]["Row"];
      };
      /**
       * O UNICO caminho para uma linha nova em `assets` (0020). O cliente
       * perdeu o INSERT: linha aqui significa que os bytes do objeto foram
       * lidos e aprovados por `/api/templates/header/confirmar`.
       */
      register_header_asset: {
        Args: {
          p_user_id: string;
          p_r2_key: string;
          p_mime: string;
          p_bytes: number;
          p_sha256?: string | null;
        };
        Returns: Database["public"]["Tables"]["assets"]["Row"];
      };
      /** Apaga a linha vencida e devolve a chave, para o worker apagar o PNG. */
      expire_previews: {
        Args: { p_max?: number };
        Returns: { r2_key: string }[];
      };

      // --- Fase 7: entrega (0021) -------------------------------------------
      // `request_zip` e `requeue_failed_jobs` sao chamadas pelo servidor com o
      // dono vindo da sessao; o resto e conversa entre o worker e o banco.

      /**
       * Enfileira o pacote do projeto — ou devolve o que ja existe, quando o
       * conjunto de videos prontos nao mudou (o `digest` da 0021).
       */
      request_zip: {
        Args: { p_user_id: string; p_project_id: string };
        Returns: Database["public"]["Tables"]["batch_zips"]["Row"];
      };
      /** Conjunto vazio quando nao ha pacote na fila (nao e composto nulo). */
      claim_zip: {
        Args: { p_worker: string; p_stale_min?: number };
        Returns: {
          id: string;
          user_id: string;
          project_id: string;
          attempts: number;
          expires_at: string;
          projeto: string;
        }[];
      };
      /** Os videos `done` do projeto do pacote, resolvidos pelo id do pacote. */
      zip_items: {
        Args: { p_zip_id: string };
        Returns: {
          job_id: string;
          filename: string | null;
          r2_key: string;
          bytes: number | null;
          pronto_em: string | null;
        }[];
      };
      /** Renova o claim durante a montagem. `false` = o pacote nao e mais seu. */
      zip_beat: {
        Args: { p_id: string; p_attempt: number };
        Returns: boolean;
      };
      finish_zip: {
        Args: {
          p_id: string;
          p_attempt: number;
          p_key: string;
          p_bytes: number;
          p_videos: number;
        };
        Returns: Database["public"]["Tables"]["batch_zips"]["Row"];
      };
      fail_zip: {
        Args: {
          p_id: string;
          p_attempt: number;
          p_mensagem: string;
          p_definitivo?: boolean;
          p_max?: number;
        };
        Returns: Database["public"]["Tables"]["batch_zips"]["Row"];
      };
      /** Apaga a linha vencida e devolve a chave, para o worker apagar o .zip. */
      expire_zips: {
        Args: { p_max?: number };
        Returns: { r2_key: string }[];
      };
      /**
       * "Reprocessar os que falharam": os `failed` voltam para `queued` na
       * MESMA linha. Cobra cota de novo, porque `fail_job` a devolveu.
       */
      requeue_failed_jobs: {
        Args: {
          p_user_id: string;
          p_project_id: string;
          p_snapshot: Json;
          /** Nulo = todos os que falharam no projeto. */
          p_job_ids?: string[] | null;
        };
        /** Quantos jobs sairam de `failed` para `queued`. */
        Returns: number;
      };

      // --- Fase 8: cobranca (0022) -------------------------------------------

      /**
       * O acesso pago de QUEM CHAMOU. Sem argumento de proposito: ela e
       * executavel por `authenticated` (a politica de insert de `schedules`
       * chama-a), e com um parametro `uuid` viraria um oraculo sobre a
       * assinatura dos outros. Le `auth.uid()` por dentro.
       */
      assinatura_ativa: {
        Args: Record<PropertyKey, never>;
        Returns: boolean;
      };
      /** A mesma pergunta, com dono explicito. `service_role` so. */
      assinatura_ativa_de: {
        Args: { p_user_id: string };
        Returns: boolean;
      };
      /**
       * Registra e aplica um evento da Stripe numa transacao so: o insert em
       * `webhook_events` e a mudanca de estado sao atomicos, e e o
       * `unique (event_id)` que garante que reentrega nao tem efeito.
       *
       * A traducao do payload acontece em `@/lib/stripe/eventos`, no
       * TypeScript, e nao aqui — a forma dos objetos da Stripe muda de versao
       * para versao, e cavar jsonb atras deles numa migration seria escrever um
       * parser de API externa sem tipo e sem teste.
       */
      apply_stripe_event: {
        Args: {
          p_event_id: string;
          p_type: string;
          p_created: string;
          p_payload: Json;
          p_user_id: string;
          p_customer_id?: string | null;
          p_subscription_id?: string | null;
          p_status?: string | null;
          p_price_id?: string | null;
          p_plan_slug?: string | null;
          p_period_start?: string | null;
          p_period_end?: string | null;
          p_cancel_at_period_end?: boolean | null;
          p_cancel_at?: string | null;
          p_canceled_at?: string | null;
          p_payment_state?: PaymentState | null;
          p_reset_quota?: boolean;
        };
        /** `repetido` | `fora-de-ordem` | `aplicado`. */
        Returns: string;
      };

      // --- Fase 9: legendas (0023) -------------------------------------------

      /**
       * Autoriza e COBRA `p_seconds` de transcricao do dono do job. Devolve
       * quantos segundos sobram no periodo. `PM034` quando nao cabe, `PM016`
       * quando o job nao e mais deste worker.
       *
       * So o worker chama. Cobra ANTES da CPU ser gasta — cobrar depois seria
       * descobrir que a conta estourou quando os minutos de processador ja
       * foram embora.
       */
      reserve_transcription: {
        Args: { p_job_id: string; p_attempt: number; p_seconds: number };
        /** Segundos restantes no periodo. */
        Returns: number;
      };
      /**
       * Grava `jobs.r2_srt_key` assim que o SRT sobe — ANTES do render, para a
       * tentativa seguinte reaproveitar em vez de transcrever de novo. Irma de
       * `job_probe`. `false` = o job nao e mais deste worker.
       */
      job_srt: {
        Args: {
          p_job_id: string;
          p_attempt: number;
          p_key: string;
          p_seconds?: number | null;
        };
        Returns: boolean;
      };
      /**
       * "Renderizar de novo com a legenda corrigida": os `done` que ja tem
       * `r2_srt_key` voltam para `queued` na MESMA linha. Cobra cota de video
       * (e um render inteiro), nao cobra cota de transcricao (nao transcreve).
       */
      requeue_subtitled_jobs: {
        Args: {
          p_user_id: string;
          p_project_id: string;
          p_snapshot: Json;
          /** Nulo = todos os videos com legenda do projeto. */
          p_job_ids?: string[] | null;
        };
        /** Quantos jobs sairam de `done` para `queued`. */
        Returns: number;
      };

      // --- Fase 10: LGPD, exclusao e exportacao (0024) ------------------------
      // Todas so com `service_role`, e a exportacao tambem — ela e `security
      // definer` e recebe o dono por parametro, entao concedida ao cliente
      // bastaria trocar o UUID para ler a conta alheia.

      /** Tudo que o titular tem no banco, em JSON. Sem as colunas de token. */
      export_account_data: {
        Args: { p_user_id: string };
        Returns: Json;
      };
      /** Todos os tokens do usuario, para revogar na Meta antes do purge. */
      ig_account_tokens: {
        Args: { p_user_id: string };
        Returns: {
          id: string;
          ig_user_id: string;
          username: string;
          status: IgAccountStatus;
          cipher_hex: string | null;
          iv_hex: string | null;
          tag_hex: string | null;
          key_version: number;
        }[];
      };
      /**
       * Abre a solicitacao ANTES de destruir qualquer coisa. Idempotente por
       * usuario: o segundo clique devolve o mesmo codigo com `ja_aberto`.
       */
      open_account_deletion: {
        Args: { p_user_id: string; p_code: string; p_ip?: string | null };
        Returns: {
          confirmation_code: string;
          request_id: string;
          ja_aberto: boolean;
        }[];
      };
      /** Apaga as linhas do titular e anonimiza `audit_log`. Contagem por tabela. */
      purge_account: {
        Args: { p_user_id: string; p_code: string };
        Returns: Json;
      };
      /** A exclusao parou no meio: `processing` vira `failed`, nada e apagado. */
      fail_account_deletion: {
        Args: { p_code: string; p_motivo: string };
        Returns: undefined;
      };
      /**
       * Poda o `payload` de webhooks mais velhos que `p_dias`. A LINHA e o
       * `event_id` ficam: sao eles que fazem a idempotencia da Fase 8.
       * Devolve quantos foram podados. Chamada pelo cron diario.
       */
      expire_webhook_events: {
        Args: { p_dias?: number };
        Returns: number;
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
      preview_status: PreviewStatus;
      zip_status: ZipStatus;
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
export type Schedule = Tables<"schedules">;
export type Template = Tables<"templates">;
export type TemplatePreview = Tables<"template_previews">;
export type BatchZip = Tables<"batch_zips">;
export type Subscription = Tables<"subscriptions">;
