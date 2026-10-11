# Not responding players

A client that stops sending updates -- buggy, crashed, a dropped tab, or a
tank caught in a collision livelock -- is marked not responding, as upstream
marks one. Upstream references are paths under `$HOME/bzflag/`.

## What bzo does

`_notRespondingTime` (`global.cxx:103`, 5 seconds; see
[bzdb.md](bzdb.md)) is how long a playing tank may go unheard. Upstream's
receivers each measure it (`Player::doDeadReckoning`, `Player.cxx:1329`);
bzo's server measures it once, from the last move it received
(`checkNotResponding`, `noteHeardFrom` in `server.js`), and never below two of
its own idle heartbeats (`MAX_UPDATE_INTERVAL`), so an honest idle tank does
not flicker. A spawn or a join starts the clock again.

When a tank crosses it, bzo does what bzfs does (`bzfs.cxx:5808`): a new
rabbit if it was the rabbit, and its flag dropped where it was last seen. Its
record carries `notResponding`, so browsers draw upstream's `[nr]` beside the
name (`ScoreboardRenderer.cxx:802`) and say "<player> not responding", then
"<player> okay" on its next move (`playing.cxx:7323-7329`). It is not a lock
target meanwhile (`playing.cxx:4426`), and its radar blip, like a paused
tank's, is its colour at 40% (`RadarRenderer.cxx:115`).

Native BZFlag clients judge it for themselves, from the updates bzo relays,
against the same `_notRespondingTime`.
