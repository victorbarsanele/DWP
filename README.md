# PostgreSQL local

Compose PostgreSQL usa `fsync=off`, `synchronous_commit=off` e
`full_page_writes=off` somente para acelerar dev/teste local. Não usar em
produção.