"""
API do produto: recebe o grafo de Markov desenhado na interface e devolve
Λ, PFD(t), PFDavg, T_I máximo para o SIL requerido e o erro de validação.

Rode localmente com:
    uvicorn app:app --reload --port 8000
"""

from pathlib import Path

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel, Field
from mpmath import mp

import core

app = FastAPI(title="Markov SIL — solver de PFD/SIL")

# CORS liberado: útil se o frontend for servido de outra origem em desenvolvimento
app.add_middleware(
    CORSMiddleware, allow_origins=["*"],
    allow_methods=["*"], allow_headers=["*"],
)

FRONTEND = Path(__file__).resolve().parent.parent / "frontend"


# --------------------------- modelos de entrada ---------------------------- #
class Transicao(BaseModel):
    origem: int
    destino: int
    taxa: str


class Grafo(BaseModel):
    n_estados: int = Field(..., ge=1)
    transicoes: list[Transicao] = []
    params: dict[str, str] = {}
    inicial: list[float] = []
    indisponiveis: list[int] = []
    sil_alvo: int = Field(2, ge=1, le=4)
    T_missao: float = Field(8760.0, gt=0)   # janela da curva PFD(t)
    varredura: bool = True                  # calcula PFDavg × T_I
    J: int = Field(16, ge=4, le=24)


def _f(x):
    return float(x)


def _valida_grafo(g: Grafo):
    erros = []
    n = g.n_estados
    for t in g.transicoes:
        if not (0 <= t.origem < n) or not (0 <= t.destino < n):
            erros.append(f"transição {t.origem}→{t.destino} fora do intervalo de estados")
    for u in g.indisponiveis:
        if not (0 <= u < n):
            erros.append(f"estado indisponível {u} inexistente")
    if not g.indisponiveis:
        erros.append("nenhum estado indisponível marcado — PFD será zero")
    if len(g.inicial) != n:
        erros.append("vetor P(0) com tamanho diferente do nº de estados")
    return erros


# ------------------------------ endpoint ----------------------------------- #
@app.post("/api/analyze")
def analyze(g: Grafo):
    erros = _valida_grafo(g)
    # erros que impedem o cálculo
    fatais = [e for e in erros if "fora do intervalo" in e or "inexistente" in e or "P(0)" in e]
    if fatais:
        return {"ok": False, "erros": erros}

    try:
        Lam = core.build_lambda(
            g.n_estados,
            [t.model_dump() for t in g.transicoes],
            g.params,
        )
    except ValueError as exc:
        return {"ok": False, "erros": [f"taxa inválida: {exc}"]}

    P0 = g.inicial if g.inicial else [1] + [0] * (g.n_estados - 1)
    U = g.indisponiveis
    J = g.J

    resp = {
        "ok": True,
        "erros": erros,
        "lambda": [[_f(Lam[i, j]) for j in range(g.n_estados)]
                   for i in range(g.n_estados)],
    }

    if not U:                       # sem estados falhos: nada a calcular
        return resp

    # curva PFD(t) na janela de missão
    tempos, pfd = core.pfd_t(Lam, P0, g.T_missao, U, J)
    resp["pfd_t"] = {"t": [_f(t) for t in tempos], "pfd": [_f(p) for p in pfd]}

    # PFDavg e SIL no T de missão
    pavg = core.pfd_avg(Lam, P0, g.T_missao, U, J)
    resp["pfdavg_missao"] = _f(pavg)
    resp["sil_missao"] = core.sil_de_pfd(pavg)

    # T_I máximo para o SIL alvo
    limite = mp.mpf(10) ** (-g.sil_alvo)
    resp["limite_sil"] = _f(limite)
    ti = core.ti_maximo(Lam, P0, U, limite, J=J)
    resp["ti_max"] = _f(ti) if ti is not None else None
    if ti is not None:
        resp["pfdavg_no_timax"] = _f(core.pfd_avg(Lam, P0, ti, U, J))

    # validação independente vs exp(Λt)·P(0)
    resp["validacao"] = _f(core.validar(Lam, P0, g.T_missao, J))

    # varredura PFDavg × T_I (para o gráfico com faixas de SIL)
    if g.varredura:
        if ti is not None:
            t_min, t_max = ti / 25, ti * 3.5
        else:
            t_min, t_max = g.T_missao / 50, g.T_missao
        n = 60
        passo = (t_max - t_min) / (n - 1)
        Ts = [t_min + passo * i for i in range(n)]
        resp["varredura"] = {
            "T": [_f(T) for T in Ts],
            "pfdavg": [_f(core.pfd_avg(Lam, P0, mp.mpf(T), U, J)) for T in Ts],
        }
    return resp


@app.get("/api/health")
def health():
    return {"status": "ok"}


# o frontend é servido pela própria API (facilita o deploy num único serviço)
if FRONTEND.exists():
    app.mount("/", StaticFiles(directory=str(FRONTEND), html=True), name="static")


if __name__ == "__main__":
    import os
    import uvicorn
    # em plataformas como Render/Railway a porta vem na variável PORT
    uvicorn.run(app, host="0.0.0.0", port=int(os.environ.get("PORT", 8000)))
