import { SingleEventSource } from "./EventSource";

import PartySocket from "partysocket";

const authTimeout = 10000;
const socketConnectTimeout = 10000;
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

//* [todo] Adding a protocol for diconnecting, and custom errors
//* [todo] adding proper protcol for everything including auth
//* [todo] move the socketListeners to top level and removing them
//* [todo] adding proper cleanups
//* [todo] adding statuses & pausing/resuming eventsources
//* [todo] same as above make sure eventSource LISTENERS DON'T GET MESSAGE before open resolved
//* [todo] adding failed states
//* [todo] also add/remove listeners for navigator online/offline &  window focus
//* [todo] also add/remove internal signals for close and error (check what the error  code is all about in websocket error & see if it's a possibility)
//* [todo] plan on adding this back to partyworks :)

//* [todo] adding teardown properly, see liveblocks when the y remove what message
//* [TODO] MAKE PING A SEPARATE FUNCITON THAT TAKES BACK TO Conneciton, and onConnection should be a timeout not interval.this will allow for easily moving between when we want to ping on our end
//* [todo] add a proper reset on diconnection & proper connections & counter states
//* [todo] goes with the first one, adding proper function handlers for events
//* [todo] add event listerners and remove them, for Window focus, navigator offline/online
//* [todo] check to see if pausing messages is even necessary, or maybe adding 2 separate quques, still pausing would be required or maybe configurable evem
//* [todo] add connection status & failed state as well
//*

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
  eventHub: { messages: SingleEventSource<MessageEvent<any>> };
  counter = 0;

  constructor(private options: ConnOptions) {
    this.eventHub = {
      messages: new SingleEventSource<MessageEvent<any>>(),
    };

    if (!options.userId) {
      options.userId = generateUUID();
    }
  }

  onSocketError = (event: Event) => {
    console.log(`[Socket internal error]`, event);
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
      this.stateBlock = "failed";
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

    console.log(`[Connection Url] ${url}`);

    return url;
  }

  //block
  async authentication() {
    this.stateBlock = "auth";
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

    if (error instanceof StopRetry) {
      console.log(`[Auth Fail] Server said stop retry`);
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
    this.authRetry = 0;

    try {
      let conn = await this._connectSocket(
        this.buildUrl({
          host: params?.host || this.options.host,
          room: params?.room || this.options.room,
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
    let messageListenerRef: (v: any) => void;
    let connectionResolverRef: (v: any) => void;
    let cleanupRejectRef: (v: any) => void;

    const connectedSock = new Promise<WebSocket>((resolve, reject) => {
      const conn = new WebSocket(url);

      con = conn;

      const messageListener = (e: MessageEvent<any>) => {
        this.eventHub.messages.notify(e);
      };
      messageListenerRef = messageListener;

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
        conn.removeEventListener("message", messageListener);
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

      conn.addEventListener("message", messageListener);

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
        (con as WebSocket)?.removeEventListener("message", messageListenerRef!);

        (con as WebSocket)?.close();
      }
      throw error;
    }
  }

  //cell
  connectionError(counter: number, error: any) {
    this.stateBlock = "connectionError";

    if (error instanceof StopRetry) {
      console.log(`[Stop Retry] Connection Failed`);
      return;
    }

    if (this.connRetry >= maxConnTries) {
      console.log(`[Max Conn Tries] moving to -> Connection Failed`);
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

  //cell
  async connected(counter: number, conn: WebSocket) {
    this.stateBlock = "connected";
    this.connRetry = 0;
    const interval = setInterval(() => {
      //* ok here what's the scenario ?
      //* let's say a reconnect happened
      //* the normal assumption would be that the socket is closed
      //* so we just check the counter every interval/timeout
      //* if the counters off we just clear the intervals & timeouts
      //* and assume that the conn will get taken care of

      if (counter !== this.counter) {
        console.log(`[stale] [CONNECTED PING]`);
        clearInterval(interval);

        return;
      }

      console.log(`[CONNECTED PING]`);
      conn.send("PING");

      const timeout = setTimeout(() => {
        if (counter !== this.counter) {
          console.log(`[stale] [PONG TIMEOUT]`);
          clearInterval(interval);
          return;
        }
        console.log(`[PONG TIMEOUT] moving to -> authentication block`);
        //cleanup socket
        clearInterval(interval);
        this.removeConnection(conn);
        this.authentication();
      }, 2000);

      const unsub = this.eventHub.messages.subscribe((e) => {
        if (e.data === "PONG") {
          console.log(`[CONNECTED PONG]`);
          clearTimeout(timeout);
          unsub();
        }
      });
    }, heartbeatInterval);
  }

  //cell
  async ping(counter: number, conn: WebSocket) {}

  //helper
  removeConnection(socket: WebSocket) {
    if (socket) {
      socket.removeEventListener("close", this.onSocketClose);
      socket.removeEventListener("error", this.onSocketError);
      socket.close();
    }
  }

  //this closes the socket, always called before reauth
  closeSocket() {
    if (this.socket) {
      console.log(`[Con closed]`);
      this.socket.removeEventListener("close", this.onSocketClose);
      this.socket.removeEventListener("error", this.onSocketError);
      this.socket.close();
      this.socket = null;
    }
  }

  start() {
    if (this.status === "stared") {
      console.warn(`Conn has already started`);
      return;
    }

    this.status = "stared";
    this.authentication();
  }

  //only stop if you want to stop the conn
  //reconn won't happen after this
  stop() {
    if (this.status === "stared") {
      this.status = "not_started";

      this.counter++;
      this.closeSocket();
      //whatever pos it's in, we can easily just increase the counter,
      //and the counter guards will take care of stopping themselves
      //we just need to close if any existing con is there

      //ok somehow make sure to cleanup this
      //close the currently ongoing stuff
      //also close the current conneciton if any
    }
  }

  //so thinking of a case where we are manually guarding
  //let's say connection only updates properly, but during that period there is a reconnect
  //and now we're guarding on the stateBlock, it's all fine
  //but assuming that the block comes to the same status when the first socket is accepted
  //aauu shit we have 2 connections
  //so we need to have exit functions that make it stale in a manner
  //but how do exit functions know what to cleanup ?
  //the cleanup then should be how?
  //this is the only case that's a race condition, and can happen
  //we need to prepare for it, the only way to make it stale somehow
  //but maybe for now let's ignore that particular case
  //the problem is that it can happen to all listeners

  //* ok got a solution for the above, i.e. having counters, everytime an event like that happens the counter is updated,
  //* we only look at the counter locally if it still matches then we win else we lose and do a cleanup

  //* rethink the scenario for simple explaination
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* reconnect happens [counter 1]
  //* goes back to authenticating [counter 1]
  //* auth resolves [counter 0] counters don;t match oops stale event, do a cleanup/exit/ignore

  //* rethink the scenario 2
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* authError [counter 0], a timeout is set to move to auth
  //* reconnect happens [counter 1]
  //* goes back to authenticating [counter 1]
  //* timeout executes [counter 0] oops counters don't match, do a cleanup

  //* ok the below scenario obv tells us to use the counter during auth only
  //* and pass the counter between calls, not very cool, but can be refactored

  //* shit scenario
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* reconnect happens [counter 1]
  //* authError [counter 1], a timeout is set to move to auth
  //* goes back to authenticating [counter 1]
  //* connection [counter 1] //conn from reconnect
  //* connection [counter 1] //conn from authError timeout

  //* rethink the scenario 3
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* authError [counter 0], a timeout is set to move to auth
  //* timeout executes [counter 0] back to authentication
  //* reconnect happens but same state, so it's ignored || //* reconnect happens but same state, so redo with counter

  //* rethink the scenario 4
  //* machine starts [counter 0]
  //* authenticating [counter 0]
  //* connection [counter 0]
  //* reconnect happens [counter 1]
  //* connection success [counter 0] but oops counter don't match, so fail & cleanup

  //* So the cases where we're in the correct place, ex
  //* connRetry moves back to auth
  //* reconnect happens
  //* since it's the same place, we leave it be? or do we redo it again? both are possible with the current setup it'll just work

  //* now a case where we're happily connected
  //* reconnect happens
  //* umm, hmm... we exited the connection, so based on our state we nead to run exitConnection cleanup funciton ithink

  //so we basically need these as gatekeepers as well for state transitiong, and the internal machine only should be responsible for the transition
  //and these will talk to the machine?
  //let's say conn is timedout & rejected, but later the conn actually get connected it may cause a race condition

  async idle() {}
  async enterAuth() {}
  //authentication
  //authError
  async exitAuth() {}
  async enterConnection() {}
  //connection
  //connectionError
  async exitConnection() {}
  enterConnected() {}
  //connected
  //connectedError
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
      this.exitConnected();
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
      this.exitConnected();
    }

    this.counter++;
  }
}

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
  waitForRoom: false,

  //use to wait for a prticular message, waitForRoom should be true
  connectionResolver: function connectionResolver(
    e: MessageEvent<any>,
    resolver
  ) {
    if (typeof e.data === "string") {
      try {
        const data = JSON.parse(e.data);

        if (data && data._pwf === "-1" && data.event === 4) {
          console.log(data);
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
