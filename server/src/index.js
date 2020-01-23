const express = require('express')
const cors = require('cors')
const { VoyagerServer } = require('@aerogear/voyager-server')
const { KeycloakSecurityService } = require('@aerogear/voyager-keycloak')
const metrics = require('@aerogear/voyager-metrics')
const auditLogger = require('@aerogear/voyager-audit')
const config = require('./config/config')
const connect = require('./db')
const { createSubscriptionServer } = require('@aerogear/voyager-subscriptions')
const { appTypeDefs, appResolvers } = require('./schema')
const agSender = require('unifiedpush-node-sender')
const path = require('path')
const makeExecutableSchema = require("apollo-server").makeExecutableSchema

process.on('unhandledRejection', error => {
  console.error('unhandledRejection', error.message);
  console.error(error.stack)
  process.exit(1);
});

let keycloakService = null
let pushClient = null

// if a keycloak config is present we create
// a keycloak service which will be passed into
// ApolloVoyagerServer
if (config.keycloakConfig) {
  keycloakService = new KeycloakSecurityService(config.keycloakConfig)
}

if (config.pushConfig) {
  let pushService = agSender(config.pushConfig)
  pushClient = pushService.then((client) => {
    return client;
  })
}

async function start() {

  const app = express()

  app.use(cors())
  metrics.applyMetricsMiddlewares(app, {
    path: '/metrics'
  })

  if (keycloakService) {
    keycloakService.applyAuthMiddleware(app)
  }

  const { applyFileMiddelware } = require('./files');
  applyFileMiddelware(app);

  app.get('/health', (req, res) => res.sendStatus(200))

  // connect to db
  const client = await connect(config.db);
  const schema = makeExecutableSchema({
    typeDefs: appTypeDefs,
    resolvers: appResolvers,
  });
  const apolloConfig = {
    schema,
    playground: config.playgroundConfig,
    introspection: true,
    context: async ({
      req
    }) => {
      // pass request + db ref into context for each resolver
      return {
        req: req,
        db: client,
        pushClient: await pushClient
      }
    },
    uploads: {
      // Limits here should be stricter than config for surrounding
      // infrastructure such as Nginx so errors can be handled elegantly by
      // graphql-upload:
      // https://github.com/jaydenseric/graphql-upload#type-uploadoptions
      maxFileSize: 10000000, // 10 MB
      maxFiles: 5
    }
  }

  const voyagerConfig = {
    securityService: keycloakService,
    // metrics,
    // auditLogger
  }

  const apolloServer = VoyagerServer(apolloConfig, voyagerConfig)

  apolloServer.applyMiddleware({ app })

  app.use('/', express.static('website'))
  app.get('*', (req, res) => {
    res.sendFile(path.resolve('website', 'index.html'));
  });

  const server = app.listen(config.port, () => {
    console.log(`\n    ***********************************************************
    🎮 Ionic PWA application available at http://localhost:${config.port}
    🚀 GraphQL Playground is available at http://localhost:${config.port}/graphql
    ***********************************************************`)
    createSubscriptionServer({
      securityService: keycloakService,
      schema: apolloServer.schema
    }, {
      path: '/graphql',
      server
    })
  })
}

start()
