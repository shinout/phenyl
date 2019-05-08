import { it, describe, afterEach, beforeEach } from "mocha";
import assert from "assert";
import { Server } from "http";
import express, { Express } from "express";
import PhenylHttpClient from "@phenyl/http-client";
import { createEntityClient } from "@phenyl/memory-db";
import PhenylRestApi from "@phenyl/rest-api";
import { createPhenylApiMiddleware, createPhenylMiddleware } from "../src";

import {
  EntityDefinition,
  CustomQueryDefinition,
  CustomQuery,
  LoginCommand,
  AuthenticationResult,
  RestApiHandler,
  CustomRequestHandler,
  KvsClient,
  Session,
  EncodedHttpRequest,
  GeneralTypeMap,
  ReqRes
} from "@phenyl/interfaces";

type Diary = ReqRes<{ id: string }>;
class DiaryDefinition implements EntityDefinition {
  async authorize() {
    return true;
  }

  async validate() {
    return undefined;
  }
}

type GetVersionParams = { name: string };
class GetVersionDefinition implements CustomQueryDefinition {
  async authorize() {
    return true;
  }
  async validate() {
    return undefined;
  }
  async execute(query: CustomQuery<"getVersion", GetVersionParams>) {
    return {
      result: {
        name: query.params.name,
        version: "1.2.3"
      }
    };
  }
}

type EntityMap = {
  member: any;
  diary: any;
};
type MemberRequest = { id: string };
type MemberResponse = { id: string; name: string; age: number };
type MemberSessionValue = { externalId: string; ttl: number };
type Credentials = { email: string; password: string };
class MemberDefinition implements EntityDefinition {
  async authorize() {
    return true;
  }
  async authenticate(loginCommand: LoginCommand<"member", Credentials>) {
    const { entityName, credentials } = loginCommand;

    const ret: AuthenticationResult<
      "member",
      MemberResponse,
      MemberSessionValue
    > = {
      preSession: {
        entityName,
        expiredAt: "",
        userId: credentials.email,
        externalId: "",
        ttl: 12345
      },
      user: { id: "bar", name: "John", age: 23 },
      versionId: "foo"
    };
    return ret;
  }
}

const fg = {
  users: { member: new MemberDefinition() },
  nonUsers: {
    diary: new DiaryDefinition()
  },
  customQueries: {
    getVersion: new GetVersionDefinition()
  },
  customCommands: {}
};

interface MyTypeMap extends GeneralTypeMap {
  entities: {
    member: ReqRes<MemberRequest, MemberResponse>,
    diary: Diary;
  };
  customQueries: {
    getVersion: {
      params: GetVersionParams;
      result: {
        name: string;
        version: string;
      };
    };
  };
}

const restApiHandler = new PhenylRestApi<MyTypeMap>(fg, {
  client: createEntityClient<EntityMap>(),
  sessionClient: createEntityClient<
    EntityMap
  >().createSessionClient() as KvsClient<Session<"member", MemberSessionValue>>
});

describe("createPhenylApiMiddleware", () => {
  let server: Server;
  let app: Express;
  beforeEach(() => {
    app = express();
    server = app.listen(3333);
  });

  afterEach(() => {
    server.close();
  });

  it("can handle Phenyl API request", async () => {
    app.use(createPhenylApiMiddleware(restApiHandler as RestApiHandler));
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const queryResult = await client.runCustomQuery({
      name: "getVersion",
      params: { name: "foo" }
    });
    assert(queryResult.result && queryResult.result.version === "1.2.3");
  });

  it("can handle non-API request by express", async () => {
    app.use(createPhenylApiMiddleware(restApiHandler as RestApiHandler));
    app.get("/foo/bar", (req, res) => {
      res.send(`Hello, Express! I'm ${req.query.name}.`);
    });
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const text = await client.requestText("/foo/bar?name=Shin");
    assert(text === "Hello, Express! I'm Shin.");
  });
  it("can handle Phenyl API request with path modifier", async () => {
    app.use(
      "/foo/bar",
      createPhenylApiMiddleware(restApiHandler as RestApiHandler)
    );
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333/foo/bar"
    });
    const queryResult = await client.runCustomQuery({
      name: "getVersion",
      params: { name: "foo" }
    });
    assert.strictEqual(queryResult.result.version, "1.2.3");
  });
  it("can handle non-API request with path modifier", async () => {
    app.use(
      "/foo/bar",
      createPhenylApiMiddleware(restApiHandler as RestApiHandler)
    );
    app.get("/foo/bar/piyo", (req, res) => {
      res.send(`Hello, Express! I'm ${req.query.name}.`);
    });
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333/foo/bar"
    });
    const text = await client.requestText("/piyo?name=Shin");
    assert.strictEqual(text, "Hello, Express! I'm Shin.");
  });
});

describe("createPhenylMiddleware", () => {
  const customRequestHandler = async (httpReq: EncodedHttpRequest) => {
    if (!httpReq.qsParams || !httpReq.qsParams.name) {
      return {
        statusCode: 401,
        body: "No name given",
        headers: { "Content-Type": "text/plain" }
      };
    }

    return {
      statusCode: 200,
      body: `Hi, Phenyl Custom Request Handler. I'm ${httpReq.qsParams.name}`,
      headers: { "Content-Type": "text/plain" }
    };
  };
  let server: Server;
  let app: Express;
  beforeEach(() => {
    app = express();
    server = app.listen(3333);
  });

  afterEach(() => {
    server.close();
  });

  it("can handle Phenyl API request", async () => {
    app.use(
      createPhenylMiddleware(
        { restApiHandler, customRequestHandler } as {
          restApiHandler: RestApiHandler;
          customRequestHandler: CustomRequestHandler<MyTypeMap>;
        },
        /\/api\/.*|\/foo\/bar$/
      )
    );
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const queryResult = await client.runCustomQuery({
      name: "getVersion",
      params: { name: "bar" }
    });

    assert(queryResult.result && queryResult.result.version === "1.2.3");
  });

  it("can handle non-API request by Phenyl Custom Request", async () => {
    app.use(
      createPhenylMiddleware(
        { restApiHandler, customRequestHandler } as {
          restApiHandler: RestApiHandler;
          customRequestHandler: CustomRequestHandler<MyTypeMap>;
        },
        /\/api\/.*|\/foo\/bar$/
      )
    );
    app.get("/foo/bar", (req, res) => {
      res.send(`Hello, Express! I'm ${req.query.name}.`);
    });
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const text = await client.requestText("/foo/bar?name=Shin");
    assert(text === "Hi, Phenyl Custom Request Handler. I'm Shin");
  });

  it("can handle non-API request by express", async () => {
    app.use(
      createPhenylMiddleware(
        { restApiHandler, customRequestHandler } as {
          restApiHandler: RestApiHandler;
          customRequestHandler: CustomRequestHandler<MyTypeMap>;
        },
        /\/api\/.*|\/foo\/bar$/
      )
    );
    app.get("/foo/bar/baz", (req, res) => {
      // This won't be called.
      res.send(`Hello, Express! I'm ${req.query.name}.`);
    });

    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const text = await client.requestText("/foo/bar/baz?name=Shin");
    assert(text === "Hello, Express! I'm Shin.");
  });

  it('can handle "/explorer" by default', async () => {
    app.use(
      createPhenylMiddleware({ restApiHandler, customRequestHandler } as {
        restApiHandler: RestApiHandler;
        customRequestHandler: CustomRequestHandler<MyTypeMap>;
      })
    );
    const client = new PhenylHttpClient<MyTypeMap>({
      url: "http://localhost:3333"
    });
    const text = await client.requestText("/explorer?name=Shin");
    assert.strictEqual(text, "Hi, Phenyl Custom Request Handler. I'm Shin");
  });
  it("can handle Phenyl API request with path modifier", async () => {
    const modifyPath = "/foo/bar";
    app.use(
      modifyPath,
      createPhenylMiddleware({
        restApiHandler,
        customRequestHandler
      } as {
        restApiHandler: RestApiHandler;
        customRequestHandler: CustomRequestHandler<MyTypeMap>;
      })
    );
    const client = new PhenylHttpClient<MyTypeMap>({
      url: `http://localhost:3333${modifyPath}`
    });
    const queryResult = await client.runCustomQuery({
      name: "getVersion",
      params: { name: "bar" }
    });

    assert.strictEqual(
      queryResult.result && queryResult.result.version,
      "1.2.3"
    );
  });
  it("can handle non-API request with path modifier", async () => {
    const modifyPath = "/foo/bar";
    app.use(
      modifyPath,
      createPhenylMiddleware({
        restApiHandler,
        customRequestHandler
      } as {
        restApiHandler: RestApiHandler;
        customRequestHandler: CustomRequestHandler<MyTypeMap>;
      })
    );
    app.get("/foo/bar/baz", (req, res) => {
      res.send(`Hello, Express! I'm ${req.query.name}.`);
    });
    const client = new PhenylHttpClient<MyTypeMap>({
      url: `http://localhost:3333${modifyPath}`
    });
    const text = await client.requestText("/baz?name=Shin");
    assert.strictEqual(text, "Hello, Express! I'm Shin.");
  });
});
