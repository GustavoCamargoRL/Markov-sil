"""
Núcleo numérico para processos de Markov homogêneos.

Extraído e reorganizado a partir do backend.py original (algoritmo de dois
passos: Transformada de Laplace + inversão por quadratura de Gauss-Legendre,
método de Oliveira et al.). Mantém a aritmética de alta precisão (mpmath),
essencial porque a matriz de inversão A é mal-condicionada.

Este módulo expõe apenas o que a interface precisa:
  - build_lambda : monta Λ a partir dos estados/transições desenhados na GUI
  - solve_markov : resolve P(t) nos nós de Gauss-Legendre
  - pfd_t        : curva PFD(t)
  - pfd_avg      : PFD média na demanda
  - ti_maximo    : intervalo de teste máximo para um SIL requerido
  - validar      : erro contra a referência exp(Λt)·P(0)
  - eval_rate    : avaliador seguro das expressões de taxa (usa parâmetros)
"""

import ast
import functools
import operator

from mpmath import mp

mp.dps = 50          # 50 dígitos decimais — necessário pelo mau condicionamento de A
J_DEFAULT = 16       # nº de nós de Gauss-Legendre (= nº de amostras de Laplace)


# --------------------------------------------------------------------------- #
# Passo 0 — nós/pesos de Gauss-Legendre e matriz de inversão (em cache por J)  #
# --------------------------------------------------------------------------- #
@functools.lru_cache(maxsize=None)
def gauss_legendre(J):
    """Nós z_i e pesos w_i de Gauss-Legendre mapeados para (0,1) (Golub-Welsch)."""
    Jac = mp.zeros(J, J)
    for k in range(1, J):
        beta = k / mp.sqrt(4 * k**2 - 1)      # entradas fora da diagonal
        Jac[k - 1, k] = beta
        Jac[k, k - 1] = beta
    E, Q = mp.eigsy(Jac)                        # E: nós em [-1,1]; Q: autovetores
    raizes, pesos = [], []
    for i in range(J):
        raizes.append((E[i] + 1) / 2)          # mapeia [-1,1] -> [0,1]
        pesos.append((2 * Q[0, i]**2) / 2)     # peso correspondente em [0,1]
    return tuple(raizes), tuple(pesos)


@functools.lru_cache(maxsize=None)
def _A_inv(J):
    """Inversa da matriz A_{s,i} = w_i z_i^{s-1}. Depende só de J → cacheada."""
    z, w = gauss_legendre(J)
    A = mp.zeros(J, J)
    for i in range(J):                          # linha = s-1
        s = i + 1
        for y in range(J):                      # coluna = índice do nó
            A[i, y] = w[y] * z[y] ** (s - 1)
    return mp.inverse(A)


# --------------------------------------------------------------------------- #
# Passo 1 — domínio de Laplace:  (sI - aΛ) P*(s) = P(0)                        #
# --------------------------------------------------------------------------- #
def _laplace(Lambda, P0col, a, J):
    n = Lambda.rows
    I = mp.eye(n)
    Pstar = mp.zeros(n, J)
    for k in range(J):
        s = k + 1
        sol = mp.lu_solve(s * I - a * Lambda, P0col)   # resolve o sistema linear
        for i in range(n):
            Pstar[i, k] = sol[i]
    return Pstar


# --------------------------------------------------------------------------- #
# Passo 2 — inversão numérica: p_n = A^{-1} P*_n                               #
# --------------------------------------------------------------------------- #
def _inverter(Pstar, J):
    n = Pstar.rows
    Ainv = _A_inv(J)
    Pt = mp.zeros(n, J)
    for i in range(n):
        col = mp.matrix([Pstar[i, k] for k in range(J)])
        r = Ainv * col
        for k in range(J):
            Pt[i, k] = r[k]
    return Pt


def _as_col(P0, n):
    c = mp.zeros(n, 1)
    for i in range(n):
        c[i, 0] = mp.mpf(P0[i])
    return c


def solve_markov(Lambda, P0, T, J=J_DEFAULT):
    """Resolve P(t) nos instantes t_i = -a·ln(z_i), com a = -T/ln(z_min).

    Retorna (times, Pt) — times é uma lista de mpf (h) e Pt é [n_estados × J].
    """
    z, _ = gauss_legendre(J)
    a = -mp.mpf(T) / mp.log(min(z))
    times = [-a * mp.log(zi) for zi in z]
    P0col = _as_col(P0, Lambda.rows)
    Pstar = _laplace(Lambda, P0col, a, J)
    Pt = _inverter(Pstar, J)
    return times, Pt


# --------------------------------------------------------------------------- #
# Indicadores de segurança: PFD(t), PFDavg, T_I máximo                         #
# --------------------------------------------------------------------------- #
def pfd_t(Lambda, P0, T, indisponiveis, J=J_DEFAULT):
    """PFD(t) = Σ_{i∈U} P_i(t), ordenada por tempo. Retorna (tempos, pfd)."""
    times, Pt = solve_markov(Lambda, P0, T, J)
    dados = sorted((times[k], sum(Pt[i, k] for i in indisponiveis)) for k in range(J))
    return [d[0] for d in dados], [d[1] for d in dados]


def pfd_avg(Lambda, P0, T, indisponiveis, J=J_DEFAULT):
    """PFDavg = (1/T)∫₀ᵀ PFD(t) dt pela regra do trapézio, ancorando PFD(0)=0."""
    tempos, pfd = pfd_t(Lambda, P0, T, indisponiveis, J)
    ts = [mp.mpf(0)] + tempos
    pf = [mp.mpf(0)] + pfd
    integral = mp.mpf(0)
    for k in range(len(ts) - 1):
        integral += (ts[k + 1] - ts[k]) * (pf[k] + pf[k + 1]) / 2
    return integral / mp.mpf(T)


def ti_maximo(Lambda, P0, indisponiveis, pfd_limite,
              T_lo=mp.mpf('1'), T_hi=mp.mpf('87600'), J=J_DEFAULT, iters=60):
    """Maior T_I com PFDavg(T_I) ≤ pfd_limite, por bisseção.

    Assume PFDavg monotônica crescente em T_I (verdade no regime só-λDU).
    Retorna None se nem o menor T_I já respeita o limite (ou nunca respeita).
    """
    lo, hi = mp.mpf(T_lo), mp.mpf(T_hi)
    if pfd_avg(Lambda, P0, lo, indisponiveis, J) > pfd_limite:
        return None                          # nem o menor intervalo atinge o SIL
    if pfd_avg(Lambda, P0, hi, indisponiveis, J) <= pfd_limite:
        return hi                            # o SIL se mantém em toda a janela
    for _ in range(iters):
        mid = (lo + hi) / 2
        if pfd_avg(Lambda, P0, mid, indisponiveis, J) > pfd_limite:
            hi = mid
        else:
            lo = mid
    return (lo + hi) / 2


def sil_de_pfd(pfdavg):
    """Classifica o SIL (modo baixa demanda) a partir do PFDavg — Tabela 1 N-2595."""
    p = float(pfdavg)
    if p >= 1e-1:
        return 0                             # abaixo de SIL 1
    if p >= 1e-2:
        return 1
    if p >= 1e-3:
        return 2
    if p >= 1e-4:
        return 3
    return 4


# --------------------------------------------------------------------------- #
# Validação independente contra a exponencial de matriz exp(Λt)·P(0)          #
# --------------------------------------------------------------------------- #
def validar(Lambda, P0, T, J=J_DEFAULT):
    """Retorna o erro absoluto máximo entre Gauss-Legendre e exp(Λt)·P(0)."""
    times, Pt = solve_markov(Lambda, P0, T, J)
    P0col = _as_col(P0, Lambda.rows)
    erro_max = mp.mpf(0)
    for k, t in enumerate(times):
        Pexp = mp.expm(Lambda * t) * P0col
        for i in range(Lambda.rows):
            erro_max = max(erro_max, abs(Pt[i, k] - Pexp[i]))
    return erro_max


# --------------------------------------------------------------------------- #
# Avaliador seguro de expressões de taxa (ex.: "3*lD", "lP + lS", "2.5e-6")    #
# --------------------------------------------------------------------------- #
_BINOPS = {ast.Add: operator.add, ast.Sub: operator.sub,
           ast.Mult: operator.mul, ast.Div: operator.truediv,
           ast.Pow: operator.pow}
_UNARY = {ast.UAdd: operator.pos, ast.USub: operator.neg}


def eval_rate(expr, params):
    """Avalia uma expressão aritmética restrita em mpmath.

    Só permite números, os nomes de `params` e + - * / ** e parênteses.
    `params` é um dict {nome: valor}. Levanta ValueError para nós proibidos.
    """
    env = {k: mp.mpf(str(v)) for k, v in params.items()}

    def _ev(node):
        if isinstance(node, ast.Expression):
            return _ev(node.body)
        if isinstance(node, ast.Constant):
            if isinstance(node.value, (int, float)):
                return mp.mpf(str(node.value))
            raise ValueError(f"constante inválida: {node.value!r}")
        if isinstance(node, ast.Name):
            if node.id in env:
                return env[node.id]
            raise ValueError(f"parâmetro não definido: {node.id!r}")
        if isinstance(node, ast.BinOp) and type(node.op) in _BINOPS:
            return _BINOPS[type(node.op)](_ev(node.left), _ev(node.right))
        if isinstance(node, ast.UnaryOp) and type(node.op) in _UNARY:
            return _UNARY[type(node.op)](_ev(node.operand))
        raise ValueError("expressão de taxa não permitida")

    tree = ast.parse(str(expr), mode="eval")
    return _ev(tree)


# --------------------------------------------------------------------------- #
# Montagem de Λ a partir do grafo desenhado na interface                       #
# --------------------------------------------------------------------------- #
def build_lambda(n_estados, transicoes, params):
    """Constrói a matriz geradora Λ (P'(t)=ΛP(t), colunas somam zero).

    Convenção (idêntica ao backend original):
        aresta origem→destino com taxa r  ⇒  Λ[destino][origem] += r
        diagonal Λ[j][j] = -Σ (taxas que saem de j)

    Parâmetros
    ----------
    n_estados   : int
    transicoes  : lista de dicts {"origem": int, "destino": int, "taxa": str|num}
    params      : dict {nome: valor} para as expressões de taxa

    Retorna Λ como mp.matrix.
    """
    Lam = mp.zeros(n_estados, n_estados)
    for t in transicoes:
        i = int(t["origem"])
        j = int(t["destino"])
        if i == j:
            continue                          # laço não altera Λ neste modelo
        r = eval_rate(t["taxa"], params)
        Lam[j, i] += r                        # entrada no destino
        Lam[i, i] -= r                        # saída da origem (diagonal)
    return Lam
