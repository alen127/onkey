//! MPRIS players are a Linux thing (mpris.rs): elsewhere there are none, so the rest of OnKey can ask without
//! asking which system it's on.
use crate::source::State;

pub const ID_PREFIX: &str = "mpris:";
pub const BUS_PREFIX: &str = "org.mpris.MediaPlayer2.";
pub const SETTING: &str = "mpris_player";

#[derive(Debug, Clone)]
pub struct Player {
    pub bus: &'static str,
    pub identity: &'static str,
    pub desktop: String,
    pub pid: Option<u32>,
}

impl Player {
    pub fn key(&self) -> &str {
        key(self.bus)
    }
}

pub fn key(bus: &str) -> &str {
    bus.strip_prefix(BUS_PREFIX).unwrap_or(bus)
}

pub fn players() -> Vec<Player> {
    Vec::new()
}

pub fn chosen() -> Option<String> {
    None
}

pub fn name(_bus: &str) -> &'static str {
    "your music player"
}

pub fn sounding(_prefer: Option<&str>) -> Option<&'static str> {
    None
}

pub fn bundle() -> &'static str {
    BUS_PREFIX
}

pub fn state() -> Option<State> {
    None
}

pub fn control(_action: &str) {}

pub fn seek(_seconds: f64) {}

pub fn play_track(_id: &str) {}
