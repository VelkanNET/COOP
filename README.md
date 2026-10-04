# CO-OP no Firebase

## Assinaturas e cobrança

Os preços são Basic semanal R$ 8,00 e mensal R$ 27,00; Standard mensal R$ 49,00 e anual R$ 199,00. Free é o plano padrão. O checkout recorrente usa o formulário hospedado do Mercado Pago. A ativação do plano só ocorre após confirmação de pagamento aprovada pelo webhook; sem renovação aprovada, o plano é rebaixado para Free no vencimento. O cliente também pode cancelar a renovação e manter o período já pago. Se uma assinatura antiga continuar autorizada depois do vencimento, é necessário cancelar sua renovação antes de iniciar outra assinatura, evitando cobranças duplicadas.

O processamento de cobrança foi preparado para Cloudflare Workers; o site, login e Firestore continuam no Firebase. Assim, o projeto não precisa migrar para Blaze para usar este backend. A ativação exige configurar uma conta Cloudflare e os segredos localmente:

1. Instale Node.js/npm e a Firebase CLI; autentique-se para publicar Hosting: `firebase login`.
2. Na raiz do projeto, autentique Wrangler com `npx wrangler login`.
3. Crie no Google Cloud um service account dedicado ao Worker, com os papéis `Cloud Datastore User` e `Firebase Authentication Admin` no projeto `coop-daf1b`. Gere uma chave JSON e guarde-a somente localmente; ela autoriza leitura/escrita do Firestore e ações administrativas de Authentication pelo backend. Nunca a coloque no repositório nem a compartilhe.
4. Rode os testes: `node --test cloudflare/worker.test.mjs` e publique o Worker: `npx wrangler deploy --config cloudflare/wrangler.toml`. O Wrangler informará um endereço como `https://coop-billing.<subdominio>.workers.dev`.
5. Cadastre os segredos no Cloudflare Wrangler, executando cada comando e digitando seu valor no prompt:
   - `npx wrangler secret put FIRESTORE_SERVICE_ACCOUNT_JSON --config cloudflare/wrangler.toml` (cole o JSON da chave em uma linha).
   - `npx wrangler secret put MERCADOPAGO_ACCESS_TOKEN --config cloudflare/wrangler.toml`.
6. No Mercado Pago, configure os eventos `subscription_preapproval` e `subscription_authorized_payment` na URL `<url-do-worker>/webhook`. Cadastre a chave secreta de assinatura com `npx wrangler secret put MERCADOPAGO_WEBHOOK_SECRET --config cloudflare/wrangler.toml`.
7. No `firebase-client.module.js`, preencha `billingWorkerUrl` com o endereço HTTPS do Worker, sem barra final. Esse mesmo Worker atende as ações privilegiadas do painel Staff e a exclusão de conta. Depois publique o site: `firebase deploy --only hosting --project coop-daf1b`.
8. Valide primeiro com credenciais/contas de teste se o Mercado Pago disponibilizar teste para assinaturas recorrentes nessa conta. Só ative credenciais de produção depois de revisar os valores e ciclos; uma cobrança real gera pagamento. O checkout só oferecerá os meios aceitos pelo Mercado Pago e a disponibilidade de Pix recorrente não é garantida.

O checkout recorrente só oferecerá os meios aceitos pelo Mercado Pago para essa assinatura e conta de vendedor. A disponibilidade de Pix para pagamentos recorrentes não é garantida pelo app; confirme as opções no checkout de produção.

O projeto ainda não tem Firebase Storage configurado. As regras de Storage referenciam o banco `default` e verificam expiração, mas precisam ser publicadas depois de inicializar Storage no Console. O limite agregado de 5 GB/10 GB também requer migrar os uploads atuais para Storage e adicionar controle de uso; o protótipo ainda não aplica essa cota.

## Firebase e limites

### Deploy automático do Hosting

O workflow `.github/workflows/firebase-hosting-deploy.yml` está preparado para publicar o Hosting ao enviar mudanças de `index.html`, `firebase-client.module.js` ou da configuração Firebase para `main`. Também pode ser iniciado manualmente em GitHub Actions. Ele não publica repetidamente sem alterações e não faz deploy por temporizador. Antes de ativá-lo, sincronize a branch `main` com a versão atual do projeto, configure no repositório o segredo GitHub `FIREBASE_SERVICE_ACCOUNT_COOP_DAF1B` com uma credencial de service account com permissão somente de deploy do Firebase Hosting, e envie o workflow para GitHub. Nunca coloque a chave no repositório. Uma vez configurado, confira a execução em Actions após o próximo push.

O Firestore deste projeto tem o ID `default` (diferente do ID especial `(default)`); o cliente e as regras selecionam esse banco explicitamente. As regras impedem que o cliente altere campos de cobrança/plano. O Cron Trigger do Worker verifica vencimentos a cada hora, e as operações protegidas também passam a ser negadas pelas regras após `planExpiresAt`. Configure também os limites/alertas de uso da Cloudflare; o plano gratuito tem quotas e a disponibilidade/limites podem mudar.

Para validar as regras do Firestore localmente, instale Java 21 ou superior e Firebase CLI e rode em `functions`: `npm run test:firestore-rules`. Os testes usam `@firebase/rules-unit-testing` e cobrem seguidores/contadores atômicos, tentativas de alteração direta, auto-seguimento, atualização de perfil, CO-OPs, chamados e recados. O ID `demo-coop-rules` é apenas local e não acessa o projeto publicado. Os testes de unidade existentes continuam em `npm test`.

O login Google, perfis, recados, CO-OPs, chamados, auditoria e publicações públicas do Home usam Authentication e Firestore. Nome, foto, biografia, LinkedIn e links externos são persistidos; a senha, o email e a autenticação em duas etapas continuam sob controle da conta Google, sem armazenamento local de credenciais. O painel Staff lê dados do Firestore em tempo real e executa mudanças de conta, plano, exclusões, ações em chamados e auditoria no Worker autenticado, que valida o token Firebase e a identidade de desenvolvedor no servidor. Para essas ações e para exclusão integral de conta, o Worker deve estar publicado e configurado com `FIRESTORE_SERVICE_ACCOUNT_JSON` e as permissões IAM descritas acima; sem isso, a interface informa que a operação falhou e não simula sucesso. Planos atribuídos manualmente pelo Staff são marcados como `staff-managed` e não expiram automaticamente.

Seguidores e pessoas seguidas são armazenados como relações independentes por UID em `users/{uid}/followers` e `users/{uid}/following`; os totais ficam nos campos `followerCount` e `followingCount` do perfil e são atualizados atomicamente na mesma transação que cria/remove as relações. As listas são atualizadas em tempo real e carregadas em páginas de até 100 perfis. Publicações, curtidas, comentários e visualizações também ficam sincronizados em tempo real. Imagens das publicações são reduzidas no navegador e armazenadas no documento Firestore com limite de tamanho; para uso de mídia em escala, migrar para Firebase Storage. Contas e publicações locais antigas não são importadas.

A configuração web do Firebase é pública por design; restrinja a chave de API no Google Cloud às APIs e origens necessárias. Nunca publique o token de acesso nem o segredo de webhook do Mercado Pago.
