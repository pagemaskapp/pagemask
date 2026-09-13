"""Sentry no worker (PLANO §7), com a mesma doutrina do app.

    "Sentry no app e no worker, com `user_id` como contexto (nunca token ou
    e-mail em breadcrumb)."

O worker e o processo do PageMask com MAIS segredo em memoria: a
`service_role` do Supabase, as credenciais do R2, a `TOKEN_ENC_KEY` e, durante
uma publicacao, o token do Instagram ja decifrado. Mandar tracebacks daqui para
um servico de terceiro so e aceitavel com as tres travas abaixo, e nenhuma
delas e padrao.

TRAVA 1 — `include_local_variables=False`
=========================================

E a mais importante, e a que ninguem lembra de ligar. Por padrao o sentry-sdk
anexa as VARIAVEIS LOCAIS de cada quadro do traceback. Em `publish.py` existe
uma variavel local chamada `token` com o access token do Instagram em texto
claro; em `banco.py`, a `service_role`. Uma excecao qualquer levantada com uma
dessas no escopo publicaria o segredo no painel de erros, com retencao de meses
— sem que nada no codigo parecesse errado.

TRAVA 2 — a varredura de texto (`_redigir`)
===========================================

O que sobra depois da trava 1 e o texto: mensagem de excecao, URL pre-assinada
do R2 num erro de rede, resposta da Meta ecoando a query. Os mesmos padroes de
`app/src/lib/observabilidade/sentry-comum.ts`, e deliberadamente duplicados —
as duas listas precisam ser lidas junto quando mudarem, e um pacote
compartilhado entre TypeScript e Python nao existe.

TRAVA 3 — nada de log automatico como breadcrumb
================================================

A `LoggingIntegration` transforma todo `logging` em breadcrumb. O worker nao
usa `logging` (usa `registro.evento`), mas uma biblioteca usa: o `botocore`
registra cada requisicao ao R2 em DEBUG, com URL assinada inteira.

SEM DSN, NAO INICIALIZA — e e o normal fora de producao.
"""
from __future__ import annotations

import os
import re
from typing import Any

_PADROES: list[tuple[re.Pattern[str], str]] = [
    # Parametro de query cujo NOME denuncia o valor: `X-Amz-Signature` da URL
    # pre-assinada, `access_token` da Meta, `apikey` do PostgREST.
    (
        re.compile(
            r"([?&#][^=&\s]*(?:token|secret|signature|credential|password|senha"
            r"|apikey|api_key|key|code|sig)[^=&\s]*=)[^&\s\"']+",
            re.IGNORECASE,
        ),
        r"\1[redigido]",
    ),
    # JWT: a `service_role` e a `anon` do Supabase.
    (re.compile(r"eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]+"), "[jwt]"),
    # Token do Instagram.
    (re.compile(r"\bIG[A-Z][A-Za-z0-9_-]{20,}"), "[token-ig]"),
    (re.compile(r"\bsb_(?:secret|publishable)_[A-Za-z0-9_-]{8,}"), "[chave-supabase]"),
    # E-mail.
    (re.compile(r"\b[\w.+-]+@[\w-]+\.[\w.-]{2,}\b"), "[email]"),
]

# 12, e nao 8: um span de requisicao vive em `evento["spans"][n]["data"]
# ["url.full"]`, e a arvore de `contexts` do SDK chega a oito niveis sozinha.
# O mesmo numero do lado do app (`sentry-comum.ts`), pela mesma razao.
_PROFUNDIDADE_MAXIMA = 12
_CAMPOS_POR_OBJETO = 80


def _redigir(texto: str) -> str:
    saida = texto
    for padrao, troca in _PADROES:
        saida = padrao.sub(troca, saida)
    return saida


def _varrer(valor: Any, profundidade: int = 0) -> Any:
    if isinstance(valor, str):
        return _redigir(valor)
    if profundidade >= _PROFUNDIDADE_MAXIMA:
        # SUBSTITUI, nao devolve. Devolver o container intacto manda para fora
        # exatamente o texto que nao foi varrido, e sem nada denunciando isso —
        # o mesmo fail-open que a revisao de seguranca da Fase 10 encontrou do
        # lado do app. Uma marca visivel no painel e um defeito que alguem
        # conserta; um vazamento silencioso, nao.
        return "[fundo demais]"
    if isinstance(valor, dict):
        return {
            chave: _varrer(item, profundidade + 1)
            for chave, item in list(valor.items())[:_CAMPOS_POR_OBJETO]
        }
    if isinstance(valor, (list, tuple)):
        return [_varrer(item, profundidade + 1) for item in list(valor)[:_CAMPOS_POR_OBJETO]]
    return valor


def _antes_de_enviar(evento: dict[str, Any], _dica: dict[str, Any]) -> dict[str, Any]:
    # O `user` fica reduzido ao `id`, quando houver. E o que o PLANO pede: id
    # para correlacionar, nada que identifique a pessoa fora do nosso banco.
    usuario = evento.get("user")
    if isinstance(usuario, dict):
        evento["user"] = {"id": usuario.get("id")} if usuario.get("id") else None

    # `server_name` e o hostname do conteiner. Nao e segredo, mas tambem nao
    # ajuda: `WORKER_NAME` ja vai como etiqueta, e e o nome que a equipe usa.
    evento.pop("server_name", None)

    return _varrer(evento)


def _antes_do_breadcrumb(
    breadcrumb: dict[str, Any], _dica: dict[str, Any]
) -> dict[str, Any] | None:
    return _varrer(breadcrumb)


def iniciar(*, worker: str, ambiente_padrao: str = "production") -> bool:
    """Liga o Sentry se houver DSN. Devolve se ligou.

    Chamada ANTES de `ambiente.carregar()` de proposito: `ConfiguracaoInvalida`
    e um dos erros que mais interessa ver no painel, e ele acontece na subida.
    Por isso esta funcao le `SENTRY_DSN` direto do ambiente, sem passar pelo
    `Ambiente` — que ainda nao existe neste ponto.

    **Nunca levanta.** Um erro na ferramenta de erro nao pode ser o motivo de o
    worker nao subir: o produto funciona sem Sentry, e uma falha aqui e avisada
    no stderr.
    """
    dsn = os.environ.get("SENTRY_DSN", "").strip()
    if not dsn:
        return False

    try:
        import sentry_sdk
        from sentry_sdk.integrations.logging import LoggingIntegration
    except ImportError:
        print(
            "sentry: SENTRY_DSN definida mas o sentry-sdk nao esta instalado",
            flush=True,
        )
        return False

    try:
        sentry_sdk.init(
            dsn=dsn,
            environment=os.environ.get("SENTRY_ENVIRONMENT", "").strip() or ambiente_padrao,
            release=os.environ.get("SENTRY_RELEASE", "").strip() or None,
            # TRAVA 1. Ver o cabecalho deste arquivo — e a linha que impede o
            # token decifrado de sair num traceback.
            include_local_variables=False,
            send_default_pii=False,
            max_request_body_size="never",
            # O worker nao serve requisicao; o traco de performance aqui nao
            # responde pergunta nenhuma que o log em JSON ja nao responda.
            #
            # QUEM FOR RELIGAR ISTO: span de requisicao guarda a URL chamada, e
            # as URLs deste processo carregam a assinatura pre-assinada do R2 e
            # o token do Instagram. O `before_send_transaction` abaixo cobre
            # isso — confira que ele continua la antes de mexer neste numero.
            traces_sample_rate=0.0,
            # TRAVA 3: nenhum registro do `logging` vira breadcrumb. O
            # `botocore` registra URL assinada em DEBUG.
            integrations=[LoggingIntegration(level=None, event_level=None)],
            before_send=_antes_de_enviar,
            # `before_send` NAO roda em evento de transacao — no SDK do Python
            # sao dois ganchos separados, e essa e a pegadinha que derrubou o
            # app na Fase 10. Hoje o worker nao emite transacao nenhuma
            # (`traces_sample_rate=0.0` acima), entao a linha abaixo nao tem o
            # que limpar; ela existe para o dia em que alguem quiser "so ver
            # onde o tempo do render vai" e subir a amostragem. Sem ela, esse
            # dia manda para o Sentry spans do botocore com a URL pre-assinada
            # do R2 inteira — sem nenhuma varredura.
            before_send_transaction=_antes_de_enviar,
            before_breadcrumb=_antes_do_breadcrumb,
        )
        sentry_sdk.set_tag("worker", worker)
        sentry_sdk.set_tag("componente", "worker")
        return True
    except Exception as erro:  # noqa: BLE001 — a ferramenta de erro nao derruba o worker
        print(f"sentry: nao foi possivel iniciar ({type(erro).__name__})", flush=True)
        return False


def capturar(erro: BaseException, **etiquetas: Any) -> None:
    """Manda uma excecao para o Sentry, se ele estiver ligado.

    `**etiquetas` entra como contexto (`job_id`, `etapa`, `user_id`) — os mesmos
    campos do log em JSON, para os dois lados falarem a mesma lingua na hora de
    cruzar um erro do painel com o `docker logs`.

    Sem DSN, `sentry_sdk.capture_exception` e uma chamada barata que nao faz
    nada; nao ha necessidade de guardar estado aqui.
    """
    try:
        import sentry_sdk
    except ImportError:
        return

    try:
        with sentry_sdk.new_scope() as escopo:
            for chave, valor in etiquetas.items():
                if valor is None:
                    continue
                escopo.set_tag(chave, _redigir(str(valor))[:200])
            sentry_sdk.capture_exception(erro)
    except Exception:  # noqa: BLE001 — nunca derrubar quem nos chamou
        pass
