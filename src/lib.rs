use js_sys::Math;
use serde::{Deserialize, Serialize};
use std::{cell::RefCell, collections::HashMap};
use worker::*;

#[derive(Serialize, Deserialize, Clone)]
struct Player {
    id: String,
    x: f64,
    z: f64,
    yaw: f64,
    color: String,
}

#[derive(Deserialize)]
struct UpdatePayload {
    #[serde(rename = "type")]
    kind: String,
    x: Option<f64>,
    z: Option<f64>,
    yaw: Option<f64>,
}

#[derive(Serialize)]
#[serde(tag = "type")]
enum Outgoing {
    #[serde(rename = "welcome")]
    Welcome { id: String, players: Vec<Player> },
    #[serde(rename = "state")]
    State { players: Vec<Player> },
}

#[durable_object(websocket)]
pub struct GameRoom {
    state: State,
    env: Env,
    players: RefCell<HashMap<String, Player>>,
    connections: RefCell<Vec<(WebSocket, String)>>,
}

impl GameRoom {
    fn new_player_id(&self) -> String {
        let random_value = (Math::random() * 0xffff_ffff_f64) as u32;
        format!("player-{:08x}", random_value)
    }

    fn pick_color(&self) -> String {
        let colors = ["#38bdf8", "#f97316", "#a78bfa", "#22c55e", "#f43f5e"];
        let index = (Math::random() * (colors.len() as f64)).floor() as usize;
        colors[index.min(colors.len() - 1)].to_string()
    }

    fn serialize_message(&self, message: &Outgoing) -> Result<String> {
        serde_json::to_string(message).map_err(Error::from)
    }

    fn send_welcome(&self, ws: &WebSocket, id: &str) -> Result<()> {
        let payload = Outgoing::Welcome {
            id: id.to_string(),
            players: self.players.borrow().values().cloned().collect(),
        };
        ws.send_with_str(&self.serialize_message(&payload)?)
    }

    fn broadcast_state(&self) -> Result<()> {
        let payload = self.serialize_message(&Outgoing::State {
            players: self.players.borrow().values().cloned().collect(),
        })?;

        for (ws, _) in self.connections.borrow().iter() {
            let _ = ws.send_with_str(&payload);
        }

        Ok(())
    }

    fn player_id_for_ws(&self, ws: &WebSocket) -> Option<String> {
        self.connections
            .borrow()
            .iter()
            .find(|(conn, _)| conn == ws)
            .map(|(_, id)| id.clone())
    }

    fn remove_connection(&self, ws: &WebSocket) -> Option<String> {
        let mut connections = self.connections.borrow_mut();
        if let Some(position) = connections.iter().position(|(conn, _)| conn == ws) {
            Some(connections.remove(position).1)
        } else {
            None
        }
    }
}

impl DurableObject for GameRoom {
    fn new(state: State, env: Env) -> Self {
        Self {
            state,
            env,
            players: RefCell::new(HashMap::new()),
            connections: RefCell::new(Vec::new()),
        }
    }

    async fn fetch(&self, _req: Request) -> Result<Response> {
        let websocket_pair = WebSocketPair::new()?;
        let server_socket = websocket_pair.server.clone();

        let player_id = self.new_player_id();
        let player = Player {
            id: player_id.clone(),
            x: 0.0,
            z: 0.0,
            yaw: 0.0,
            color: self.pick_color(),
        };

        self.players.borrow_mut().insert(player_id.clone(), player);
        self.connections
            .borrow_mut()
            .push((server_socket.clone(), player_id.clone()));

        self.state.accept_web_socket(&server_socket);
        self.send_welcome(&server_socket, &player_id)?;
        self.broadcast_state()?;

        Response::from_websocket(websocket_pair.client)
    }

    async fn websocket_message(
        &self,
        ws: WebSocket,
        message: WebSocketIncomingMessage,
    ) -> Result<()> {
        if let WebSocketIncomingMessage::String(text) = message {
            if let Ok(payload) = serde_json::from_str::<UpdatePayload>(&text) {
                if payload.kind == "update" {
                    if let Some(player_id) = self.player_id_for_ws(&ws) {
                        if let Some(player) = self.players.borrow_mut().get_mut(&player_id) {
                            if let Some(x) = payload.x {
                                player.x = x;
                            }
                            if let Some(z) = payload.z {
                                player.z = z;
                            }
                            if let Some(yaw) = payload.yaw {
                                player.yaw = yaw;
                            }
                            self.broadcast_state()?;
                        }
                    }
                }
            }
        }

        Ok(())
    }

    async fn websocket_close(
        &self,
        ws: WebSocket,
        _code: usize,
        _reason: String,
        _was_clean: bool,
    ) -> Result<()> {
        if let Some(player_id) = self.remove_connection(&ws) {
            self.players.borrow_mut().remove(&player_id);
            self.broadcast_state()?;
        }
        Ok(())
    }
}

#[event(fetch)]
pub async fn main(req: Request, env: Env, _ctx: Context) -> Result<Response> {
    let url = Url::parse(&req.url())?;

    match url.path().as_str() {
        "/client.js" => Response::ok(CLIENT_JS)?.with_header("content-type", "application/javascript; charset=utf-8"),
        "/" => Response::ok(INDEX_HTML)?.with_header("content-type", "text/html; charset=utf-8"),
        "/ws" => {
            let namespace = env.durable_object("GAME_ROOM")?;
            let stub = namespace.get_by_name("default")?;
            stub.fetch_with_request(req).await
        }
        _ => Response::ok("Not found")?.with_status(404),
    }
}

const INDEX_HTML: &str = include_str!("../index.html");
const CLIENT_JS: &str = include_str!("../client.js");
