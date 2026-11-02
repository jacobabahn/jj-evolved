#!/usr/bin/env python3
"""Builds synthetic histories with git fast-import, then imports them with jj. Usage: gen.py <work-dir>"""
import os, random, subprocess, sys, time
W = sys.argv[1]; SRC = f"{W}/src-git"; REPOS = f"{W}/repos"
ENV = {**os.environ, "JJ_CONFIG": f"{W}/jj-config.toml"}
WORDS = "fix add remove update refactor parser index cache revset graph commit tree merge rebase config test docs layout render handle error path file store lock retry timeout buffer stream queue worker memory thread".split()

def description(r):
    subject = " ".join(r.choices(WORDS, k=r.randint(4, 9)))
    return subject + ("\n\n" + " ".join(r.choices(WORDS, k=r.randint(30, 90))) + "\n" if r.random() < .4 else "\n")
def path(i): return f"d{i % 100:02d}/s{(i // 100) % 100:02d}/f{i}.txt"
class Stream:
    def __init__(self, repo):
        self.p = subprocess.Popen(["git", "fast-import", "--quiet", "--done"], cwd=repo, stdin=subprocess.PIPE)
        self.mark = 0; self.t = 1_500_000_000
    def w(self, s): self.p.stdin.write(s.encode() if isinstance(s, str) else s)
    def data(self, payload):
        b = payload.encode() if isinstance(payload, str) else payload
        self.w(f"data {len(b)}\n"); self.w(b); self.w("\n")
    def commit(self, ref, msg, parent, changes, deletes=()):
        self.mark += 1; self.t += 60; m = self.mark
        self.w(f"commit {ref}\nmark :{m}\nauthor Bench Author <a@example.com> {self.t} +0000\ncommitter Bench Author <a@example.com> {self.t} +0000\n")
        self.data(msg)
        if parent: self.w(f"from :{parent}\n")
        for f, c in changes:
            self.w(f"M 100644 inline {f}\n"); self.data(c)
        for f in deletes: self.w(f"D {f}\n")
        self.w("\n")
        return m
    def reset(self, ref, mark): self.w(f"reset {ref}\nfrom :{mark}\n\n")
    def done(self):
        self.w("done\n"); self.p.stdin.close()
        if self.p.wait(): raise SystemExit("fast-import failed")
def bare(name):
    repo = f"{SRC}/{name}.git"
    subprocess.check_call(["git", "init", "-q", "--bare", "-b", "main", repo]); return repo
def clone(name):
    t = time.time()
    subprocess.check_call(["jj", "git", "clone", "--quiet", f"file://{SRC}/{name}.git", f"{REPOS}/{name}"], env=ENV)
    print(f"{name}: jj clone {time.time()-t:.1f}s", flush=True)

def linear(name, commits, files, branches=0):
    if os.path.exists(f"{REPOS}/{name}"): return
    r = random.Random(name); repo = bare(name); s = Stream(repo)
    m = s.commit("refs/heads/main", "initial tree\n", None, [(path(i), f"file {i}\n" + "line\n" * 8) for i in range(files)])
    marks = [m]
    for c in range(commits - 1):
        m = s.commit("refs/heads/main", description(r), m, [(path(r.randrange(files)), f"revision {c}\n" + "line\n" * r.randint(1, 12)) for _ in range(2)])
        if branches: marks.append(m)
    for b in range(branches):
        side = s.commit(f"refs/heads/feature/{b}", description(r), r.choice(marks), [(path(r.randrange(files)), f"branch {b}\n")])
    s.done(); clone(name)

def diffs(name="diffs"):
    if os.path.exists(f"{REPOS}/{name}"): return
    r = random.Random(name); repo = bare(name); s = Stream(repo)
    code = lambda n, salt: "".join(f"export function item{i}(value: number): number {{ return value * {i + salt} + {r.randint(0, 999)}; }}\n" for i in range(n))
    base = [(path(i), f"file {i}\n" + "line\n" * 8) for i in range(2000)]
    big = {n: code(n, 0) for n in (1000, 10000, 100000)}
    base += [(f"code/l{n}.ts", big[n]) for n in big]
    hunky = {n: "".join(f"line {i}\n" for i in range(n * 6)) for n in (1000, 10000)}
    base += [(f"code/h{n}.txt", hunky[n]) for n in hunky]
    m = s.commit("refs/heads/main", "base\n", None, base)
    tick = lambda label, m: s.commit("refs/heads/main", f"small after {label}\n", m, [(f"marker/{label}.txt", label + "\n")])
    marks = {}
    def add(label, changes):
        nonlocal m
        m = s.commit("refs/heads/main", f"huge {label}\n", m, changes); marks[label] = True
        m = tick(label, m)
    for n in big: add(f"lines{n}", [(f"code/l{n}.ts", code(n, 1))])
    for n in (100, 1000, 2000): add(f"files{n}", [(path(i), f"changed file {i}\n" + "line\n" * 8) for i in range(n)])
    for n in hunky:
        lines = hunky[n].splitlines(True)
        for i in range(0, len(lines), 6): lines[i] = f"changed {i}\n"
        add(f"hunks{n}", [(f"code/h{n}.txt", "".join(lines))])
    add("minified2mb", [("code/min.json", '{"k":[' + ",".join(str(i) for i in range(380000)) + "]}\n")])
    add("noisy400files", [(f"code/n{i}.ts", code(400, i)) for i in range(400)])
    for i in range(10): m = s.commit("refs/heads/main", f"tail {i}\n", m, [(f"tail/{i}.txt", "x\n")])
    s.done(); clone(name)

def stack(name, base_commits, depth):
    """A mutable stack on top of trunk, imported through the colocated Git repository."""
    if os.path.exists(f"{REPOS}/{name}"): return
    linear(f"{name}-seed", base_commits, 1000)
    os.rename(f"{REPOS}/{name}-seed", f"{REPOS}/{name}")
    r = random.Random(name); repo = f"{REPOS}/{name}"
    s = Stream(repo); s.w("feature done\n") if False else None
    head = subprocess.check_output(["git", "rev-parse", "origin/main"], cwd=repo, text=True).strip()
    s.mark = 0; m = None
    for c in range(depth):
        if m is None:
            s.mark += 1; m = s.mark; s.t += 60
            s.w(f"commit refs/heads/stack\nmark :{m}\nauthor B <a@example.com> {s.t} +0000\ncommitter B <a@example.com> {s.t} +0000\n"); s.data(description(r)); s.w(f"from {head}\n")
            s.w(f"M 100644 inline stack/{c % 500}.txt\n"); s.data(f"{c}\n"); s.w("\n")
        else: m = s.commit("refs/heads/stack", description(r), m, [(f"stack/{c % 500}.txt", f"{c}\n")])
    s.done()
    subprocess.check_call(["jj", "git", "import", "--quiet"], cwd=repo, env=ENV)
    subprocess.check_call(["jj", "new", "--quiet", "stack"], cwd=repo, env=ENV)
    print(f"{name}: stack ready", flush=True)

for n, c in [("lin-1k", 1_000), ("lin-10k", 10_000), ("lin-100k", 100_000), ("lin-1m", 1_000_000)]: linear(n, c, 1000)
for n, f in [("files-10k", 10_000), ("files-100k", 100_000), ("files-300k", 300_000)]: linear(n, 1000, f)
for n, b in [("br-1k", 1_000), ("br-10k", 10_000), ("br-50k", 50_000)]: linear(n, 10_000, 1000, b)
diffs()
for n, d in [("stack-100", 100), ("stack-1k", 1000), ("stack-5k", 5000), ("stack-20k", 20000), ("stack-3900", 3900), ("stack-4000", 4000)]: stack(n, 10_000, d)
print("gen done", flush=True)
