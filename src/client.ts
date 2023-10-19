import { SingleEventSource } from "./EventSource";

import PartySocket from "partysocket";

const authTimeout = 10000;
const socketConnectTimeout = 3000;
const heartbeatInterval = 3000;
const connectionBackoff = [250, 500, 1000, 5000];
const authBackoff = [250, 500, 1000, 5000];
const maxConnTries = 7;
const maxAuthTries = 7;

const awaitPromise = <T = unknown>(
  func: Promise<T>,
  timeout: number
): Promise<T> => {
  let clearTimer: NodeJS.Timeout;
  return new Promise(async (resolve, reject) => {
    try {
      clearTimer = setTimeout(
        () => reject({ code: 99, msg: "Auth timeout" }),
        timeout
      );

      const data = await func;
      clearTimeout(clearTimer);
      resolve(data);
    } catch (error) {
      clearTimeout(clearTimer);
      reject(error);
    }
  });
};

function generateUUID(): string {
  // Public Domain/MIT
  if (typeof crypto !== "undefined" && crypto.randomUUID) {
    return crypto.randomUUID();
  }
  let d = new Date().getTime(); //Timestamp
  let d2 =
    (typeof performance !== "undefined" &&
      performance.now &&
      performance.now() * 1000) ||
    0; //Time in microseconds since page-load or 0 if unsupported
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, function (c) {
    let r = Math.random() * 16; //random number between 0 and 16
    if (d > 0) {
      //Use timestamp until depleted
      r = (d + r) % 16 | 0;
      d = Math.floor(d / 16);
    } else {
      //Use microseconds since page-load if supported
      r = (d2 + r) % 16 | 0;
      d2 = Math.floor(d2 / 16);
    }
    return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
  });
}

//* OK what features we want
//* auto reconnecting
//* ping/pong timeouts
//* status & messages
//* manual reconnect
//* manual close
//* handling error events & backoffs

//* [todo] add a proper reset on diconnection & proper connections & counter states
//* [todo] check to see if pausing messages is even necessary, or maybe adding 2 separate quques, still pausing would be required or maybe configurable evem
//* [todo] add usuable status for stateBlock, or do we let the end users determine them :/
//custom error class, that users can use to indicate stop retry, from auth & connectionResolver
class StopRetry extends Error {
  constructor(msg: string) {
    super(msg);
  }
}

interface ConnOptions {
  waitForRoom: boolean;
  host: string;
  room: string;
  userId?: string;
  party?: string;
  auth?: () => any | Promise<any>;
  connectionResolver?: (
    message: MessageEvent<any>,
    resolver: () => void
  ) => void;
}

type ConnState =
  | "initial"
  | "auth"
  | "authError"
  | "connection"
  | "connectionError"
  | "connected"
  | "failed";

//i wonder if cell status is even necessary, i don't see using them or notifying bout them :/
//block statuses are only one that're meaningful and necessary
//cell status hmm...

//pickup add proper logging options
//.start() starting is there only
//.close() and failed statuses also add
//then add easy configs
//lastly go to the world with a separate clients, ask sunil what should be done
//2 options one is it can be a separate package, other one it being internal only,
//if separate then addEventListeners are needed,
//else they don't needed

export class Conn {
  status: "stared" | "not_started" = "not_started";
  stateBlock:
    | "initial"
    | "auth"
    | "authError"
    | "connection"
    | "connectionError"
    | "connected"
    | "failed" = "initial";
  socket: WebSocket | null = null;
  connRetry: number = 0;
  authRetry: number = 0;
  eventHub: {
    messages: SingleEventSource<MessageEvent<any>>;
    status: SingleEventSource<ConnState>; //will update the status of the machine, maybe reqires a helper to get useful states
  };
  counter = 0;

  //?do we create a message buffer, before resolving the connection, if we give that config option pauseMessageBeforeConnect or something

  constructor(private options: ConnOptions) {
    this.eventHub = {
      messages: new SingleEventSource<MessageEvent<any>>(),
      status: new SingleEventSource<ConnState>(),
    };

    if (!options.userId) {
      options.userId = generateUUID();
    }
  }

  //these socket event listeners are safe tbh, why?
  //cuz sockets are almost always closed first before trying an reconn
  //saying this in context of them emitting for an old socket, and affecting the new one
  onSocketError = (event: Event) => {
    console.log(`[Socket internal error]`, event);

    if (this.socket?.readyState === 1) return;

    // this.counter++;
    // this.authentication();
    //now this remains safe
    //since the counter++ events also change the stateBlock
    //honestly we can let ping/pong decide it, but the accuracy drops to the heartbeat interval
    // we try reconnect, on our side, if it's anything other than connected we don't do anything
    if (this.stateBlock === "connected") {
      this.closeSocket();
      this.counter++;
      this.authentication();
    }
  };

  onSocketClose = (event: CloseEvent) => {
    console.log(`[Socket internal close]`, event);

    //case we got the counter
    //we got close
    //we just wait for pong timeout to retry, life good

    //case we got the counter
    //we got close
    //we have to close
    //we just wait for pong timeout to retry, life good
    //timer is increased
    //auth stops

    //case we got the counter
    //we got close
    //we have to close
    //timer is increased
    //we just wait for pong timeout to retry, life good [stale]

    //case we got the counter
    //we got close
    //we have to close
    //timer is increased
    //we just wait for pong timeout to retry, life good [stale]
    //reconnect -> timer increaed
    //auth

    //our signal to stop retry
    if (event.code === 4000) {
      this.counter++;
      this.stateBlock = "initial";
      return;
    }

    // we try reconnect, on our side, if it's anything other than connected we don't do anything
    if (this.stateBlock === "connected") {
      this.closeSocket();
      this.counter++;
      this.authentication();
    }
  };

  onSocketMessage = (event: MessageEvent<any>) => {
    this.eventHub.messages.notify(event);
  };

  tryHeartbeat = () => {
    if (this.stateBlock === "connected") {
      console.log(`[Manual Heartbeat] offline or focus`);

      //this will lead to 2 pings temporarily
      //the counter is being guarded by the status, so maybe after some proper fuzz testing we may be able to find bugs,
      //i feel like a race condition can trigger here, maybe n  ot, just the feeling in strong

      //single use ping
      this.ping(this.counter, this.socket!, true);
    }
  };

  buildUrl({
    host: rawHost,
    room,
    userId,
    protocol,
    data,
    party,
  }: {
    host: string;
    room: string;
    userId: string;
    protocol?: string;
    data: Record<string, string>;
    party?: string;
  }) {
    // strip the protocol from the beginning of `host` if any
    const host = rawHost.replace(/^(http|https|ws|wss):\/\//, "");

    let url = `${
      protocol ||
      (host.startsWith("localhost:") || host.startsWith("127.0.0.1:")
        ? "ws"
        : "wss")
    }://${host}/${party ? `parties/${party}` : "party"}/${room}`;
    if (data) {
      url += `?${new URLSearchParams({ ...data, userId }).toString()}`;
    } else {
      url += `?_pk=${userId}`;
    }

    return url;
  }

  //block
  async authentication() {
    this.stateBlock = "auth";
    this.eventHub.status.notify(this.stateBlock);
    const localCounter = this.counter;
    console.log(`[Authenticating...]`);
    if (typeof this.options.auth === "function") {
      try {
        const params = await awaitPromise(this.options.auth(), authTimeout);

        if (this.counter !== localCounter) {
          console.log(`[auth ok] but timers don't match, marked as stale`);
          return;
        }
        console.log(`[auth ok] moving to -> connection block`);

        this.connection(localCounter, params);
      } catch (error) {
        if (this.counter !== localCounter) {
          console.log(`[auth failed] but timers don't match, marked as stale`);
          return;
        }
        console.log(`[auth failed]  moving to -> error block`);
        this.authError(localCounter, error);
      }
    }
  }

  //cell
  async authError(counter: number, error: any) {
    this.stateBlock = "authError";
    this.eventHub.status.notify(this.stateBlock);

    if (error instanceof StopRetry) {
      console.log(`[Auth Fail] Server said stop retry`);
      //we consider it fail

      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      return;
    }

    //here we can check the backoffs and add delays and stuff to it
    //this is the function
    if (this.authRetry >= maxAuthTries) {
      console.log(`[Max Auth Tries] moving to -> Authentication Failed`);
      return;
    }

    setTimeout(() => {
      if (counter !== this.counter) {
        console.log(`[stale] [Switch -> Auth Block]`);
        return;
      }

      console.log(`[Switch -> Auth Block]`);

      this.authentication();
    }, authBackoff[this.authRetry] || 5000);

    console.log(`[Schedule Reauth ${authBackoff[this.authRetry] || 5000}ms]`);
    this.authRetry++;
  }

  //block
  async connection(counter: number, params: any) {
    this.stateBlock = "connection";
    this.eventHub.status.notify(this.stateBlock);
    this.authRetry = 0; //reaching here autoresets the auth , well not the best place i guess ><

    try {
      let conn = await this._connectSocket(
        this.buildUrl({
          host: params?.host || this.options.host,
          room: params?.room || this.options.host,
          userId: this.options.userId!,
          party: this.options.party,
          data: params?.data,
        })
      );

      if (counter !== this.counter) {
        console.log(`[stale] [Connection ok]`);

        conn.close();
        //@ts-ignore
        conn = null; //apparently removes all event listeners,

        //todo cleanup the socket
        return;
      }

      this.socket = conn;

      console.log(`[Connection ok] moving to -> connected block`);
      this.connected(counter, conn);
    } catch (error) {
      if (counter !== this.counter) {
        console.log(`[stale] [Connection fail]`);

        return;
      }

      console.log(`[Connection fail] moving to -> connection error block`);
      this.connectionError(counter, error);
    }
  }

  //helper
  async _connectSocket(url: string) {
    if (
      this.options.waitForRoom &&
      typeof this.options.connectionResolver !== "function"
    )
      throw new Error(
        "Bad Config, no connectionResolver provided when waitForRoom was to true"
      );
    let con: WebSocket | null = null;
    let connectionResolverRef: (v: any) => void;
    let cleanupRejectRef: (v: any) => void;

    const connectedSock = new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(url);

      con = conn;

      const connectionResolver = (e: MessageEvent<any>) => {
        if (typeof this.options.connectionResolver === "function") {
          this.options.connectionResolver(e, () => {
            conn.addEventListener("close", cleanupReject);
            conn.removeEventListener("error", cleanupReject);
            conn.removeEventListener("message", connectionResolver);
            resolve(conn);
          });
        }
      };
      connectionResolverRef = connectionResolver;

      const cleanupReject = (e: any) => {
        // console.log(`[]er `, e); // not useful, can't get any code out of it
        conn.removeEventListener("message", this.onSocketMessage);
        reject(conn);
      };

      cleanupRejectRef = cleanupReject;

      conn.addEventListener("open", () => {
        if (!this.options.waitForRoom) {
          conn.removeEventListener("close", cleanupReject);
          conn.removeEventListener("error", cleanupReject);
          resolve(conn);
        }
      });
      conn.addEventListener("close", cleanupReject);
      conn.addEventListener("error", cleanupReject);

      if (
        this.options.waitForRoom &&
        typeof this.options.connectionResolver === "function"
      )
        conn.addEventListener("message", connectionResolver);

      conn.addEventListener("message", this.onSocketMessage);
      conn.addEventListener("close", this.onSocketClose);
      conn.addEventListener("error", this.onSocketError);
    });

    try {
      const con = await awaitPromise<WebSocket>(
        connectedSock,
        socketConnectTimeout
      );
      return con;
    } catch (error) {
      //The case where the conn is timeout, but the conn succeeds, this will leave a rouge conn
      //given a normal timeout of say 10sec it's higly unlike to happen
      if (con) {
        (con as WebSocket)?.removeEventListener("close", cleanupRejectRef!);

        (con as WebSocket)?.removeEventListener("error", cleanupRejectRef!);

        (con as WebSocket)?.removeEventListener(
          "message",
          connectionResolverRef!
        );
        (con as WebSocket)?.removeEventListener(
          "message",
          this.onSocketMessage
        );

        (con as WebSocket)?.close();
      }
      throw error;
    }
  }

  //cell
  connectionError(counter: number, error: any) {
    this.stateBlock = "connectionError";
    this.eventHub.status.notify(this.stateBlock);

    if (error instanceof StopRetry) {
      console.log(`[Stop Retry] Connection Failed`);
      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      return;
    }

    if (this.connRetry >= maxConnTries) {
      console.log(`[Max Conn Tries] moving to -> Connection Failed`);
      this.stateBlock = "failed";
      this.eventHub.status.notify(this.stateBlock);
      return;
    }

    setTimeout(() => {
      if (counter !== this.counter) {
        console.log(`[stale] [Switch -> Auth Block]`);
        return;
      }

      console.log(`[Switch -> Auth Block]`);
      this.authentication();
    }, connectionBackoff[this.connRetry] || 5000);

    console.log(
      `[Schedule Reconnect ${connectionBackoff[this.connRetry] || 5000}ms]`
    );
    this.connRetry++;
  }

  //Block
  async connected(counter: number, conn: WebSocket, fromPong?: boolean) {
    this.stateBlock = "connected";
    this.eventHub.status.notify(this.stateBlock);
    if (!fromPong) this.connRetry = 0; //if this is not rebound from ping, that means a new socket just arrived, fresh & healthy, ok i need to stop writing weird comments

    setTimeout(() => {
      //* ok here what's the scenario ?
      //* let's say a reconnect happened
      //* the normal assumption would be that the socket is closed
      //* so we just check the counter every interval/timeout
      //* if the counters off we just clear the intervals & timeouts
      //* and assume that the conn will get taken care of

      if (counter !== this.counter) {
        console.log(`[stale] [CONNECTED PING]`);
        return;
      }
      this.ping(counter, conn);
    }, heartbeatInterval);
  }

  //cell
  //ok lol :< we still need the counter, making this somewhat useless
  //maybe a good thing adding locks to fsm
  //a scenario where we pass this.counter & this.socket ain't possible
  //counter ++ reconnect
  //ping with stale socket & incorrect counter
  //ok maybe we make sure to ping onlt when the state is connected?
  async ping(counter: number, conn: WebSocket, singleUse?: boolean) {
    console.log(`[CONNECTED PING]`);
    conn.send("PING");

    const timeout = setTimeout(() => {
      unsub();
      if (counter !== this.counter) {
        console.log(`[stale] [PONG TIMEOUT]`);
        return;
      }
      console.log(`[PONG TIMEOUT] moving to -> authentication block`);
      //cleanup socket
      this.removeConnection(conn);
      this.authentication();
    }, 2000);

    const unsub = this.eventHub.messages.subscribe((e) => {
      if (e.data === "PONG") {
        console.log(
          counter === this.counter
            ? `[CONNECTED PONG]`
            : `[stale] [Connected Pong]`
        );
        clearTimeout(timeout);
        unsub();

        //still safe counter
        if (counter === this.counter && !singleUse) {
          this.connected(counter, conn, true);
        }
      }
    });
  }

  //helper
  removeConnection(socket?: WebSocket) {
    if (socket) {
      socket.removeEventListener("message", this.onSocketMessage);
      socket.removeEventListener("close", this.onSocketClose);
      socket.removeEventListener("error", this.onSocketError);
      socket.close();
    }
  }

  //this closes the socket, always called before reauth
  closeSocket() {
    if (this.socket) {
      console.log(`[Con closed]`);
      this.socket.removeEventListener("message", this.onSocketMessage);
      this.socket.removeEventListener("close", this.onSocketClose);
      this.socket.removeEventListener("error", this.onSocketError);
      this.socket.close();
      this.socket = null;

      this.stateBlock = "initial"; //todo maybe add closed :/
      this.eventHub.status.notify(this.stateBlock);
    }
  }

  start() {
    if (this.status === "stared") {
      console.warn(`Conn has already started`);
      return;
    }

    //todo maybe reset all states here, or at in the stop

    this.status = "stared";
    this.authentication();

    window.addEventListener("offline", this.tryHeartbeat);
    window.addEventListener("focus", this.tryHeartbeat);

    //? should we try reconnect online, maybe in certain statuses, huh dunno :/
  }

  //only stop if you want to stop the conn
  //reconn won't happen after this
  stop() {
    if (this.status === "stared") {
      this.status = "not_started";
      this.counter++;
      this.closeSocket();
      this.eventHub.status.notify(this.stateBlock);

      window.removeEventListener("offline", this.tryHeartbeat);
      window.removeEventListener("focus", this.tryHeartbeat);
      //whatever pos it's in, we can easily just increase the counter,
      //and the counter guards will take care of stopping themselves
      //we just need to close if any existing con is there

      //ok somehow make sure to cleanup this
      //close the currently ongoing stuff
      //also close the current conneciton if any
    }
  }

  async exitConnected() {
    console.log(`[Exit Conn]`);
    this.socket?.close();
  }

  //userland events should increase the counter
  async reconnect() {
    if (this.status !== "stared") {
      console.warn(`Cannot reconnect machine is not started`);
      return;
    }

    if (this.stateBlock === "connected") {
      this.closeSocket();
    }
    this.counter++;
    this.authentication();
  }

  async close() {
    if (this.status !== "stared") {
      console.warn(`Cannot reconnect machine is not started`);
      return;
    }

    if (this.stateBlock === "connected") {
      this.closeSocket();
    }

    this.stateBlock = "initial";
    this.eventHub.status.notify(this.stateBlock);
    this.counter++;
  }
}

//

const happyAuth = () => {
  return {
    url: `ws://localhost:1999/party/b?_pk=78${Math.random().toString()}9ae98c${Math.random().toString()}-2f8b-4a5d-9c11${(
      Math.random() * Math.random()
    ).toString()}-74df958f5655`,
  };
};

const happyAuthPromise = (timeout: number = 2000) => {
  return new Promise((res, rej) => {
    setTimeout(() => {
      res({
        url: `ws://localhost:1999/party/b?_pk=78${Math.random().toString()}9ae98c${Math.random().toString()}-2f8b-4a5d-9c11${(
          Math.random() * Math.random()
        ).toString()}-74df958f5655`,
      });
    }, timeout);
  });
};

const badUrlAuth = () => {
  return {
    url: "ws://localhost:1999",
  };
};

const badAuth = () => {
  return new Promise((res, rej) => {
    rej({ code: 1 });
  });
};

const timeoutAuth = () => {
  return new Promise((res, rej) => {
    setTimeout(() => {
      res({});
    }, authTimeout + 100);
  });
};

const con = new Conn({
  host: "localhost:1999",
  room: "bb",
  auth: happyAuthPromise,
  waitForRoom: true,
  connectionResolver: function connectionResolver(
    e: MessageEvent<any>,
    resolver
  ) {
    if (typeof e.data === "string") {
      try {
        const data = JSON.parse(e.data);

        if (data && data._pwf === "-1" && data.event === 4) {
          resolver();
        }
      } catch (error) {}
    }
  },
});

con.start();
// const cons = new Party({ room: "b", host: "ws://localhost:1999" });
// con.reconnect();
// con.eventHub.messages.subscribe((msg) => {
//   console.log(msg);
// });

// setTimeout(() => {
//   con.reconnect();
// }, 2000);

const buttonElement: HTMLButtonElement = document.createElement("button");
buttonElement.textContent = "Reconnect"; // Set the button text

// Add the button to the document body or any other HTML element
document.body.appendChild(buttonElement);

// Define a click event listener function
function buttonClickHandler(event: MouseEvent) {
  con.reconnect();
}

// Attach the click event listener to the button
buttonElement.addEventListener("click", buttonClickHandler);

const cc: HTMLButtonElement = document.createElement("button");
cc.textContent = "Stop"; // Set the button text

// Add the button to the document body or any other HTML element
document.body.appendChild(cc);

// Define a click event listener function
function ccWa(event: MouseEvent) {
  con.stop();
}

// Attach the click event listener to the button
cc.addEventListener("click", ccWa);

const ss: HTMLButtonElement = document.createElement("button");
ss.textContent = "Start"; // Set the button text

// Add the button to the document body or any other HTML element
document.body.appendChild(ss);

// Define a click event listener function
function ssWa(event: MouseEvent) {
  con.start();
}

// Attach the click event listener to the button
ss.addEventListener("click", ssWa);

const dd: HTMLButtonElement = document.createElement("button");
dd.textContent = "Close"; // Set the button text

// Add the button to the document body or any other HTML element
document.body.appendChild(dd);

// Define a click event listener function
function ddWa(event: MouseEvent) {
  con.close();
}

// Attach the click event listener to the button
dd.addEventListener("click", ddWa);
