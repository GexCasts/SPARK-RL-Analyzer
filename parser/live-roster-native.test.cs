using System;
using System.Collections.Generic;
using System.Reflection;
using System.Runtime.Serialization;
using System.Web.Script.Serialization;

namespace SparkPersonalOverlay
{
    internal static class RosterTests
    {
        private static int checks;
        private static void Check(bool condition, string message)
        {
            if (!condition) throw new Exception(message);
            checks++;
        }

        private static void Main()
        {
            OverlayState state = new OverlayState();
            OverlayForm form = (OverlayForm)FormatterServices.GetUninitializedObject(typeof(OverlayForm));
            typeof(OverlayForm).GetField("state", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, state);
            MethodInfo update = typeof(OverlayForm).GetMethod("UpdatePlayers", BindingFlags.Instance | BindingFlags.NonPublic);
            JavaScriptSerializer json = new JavaScriptSerializer();
            Action<string> sync = text => update.Invoke(form, new object[] { json.DeserializeObject(text) });
            sync("{\"Players\":[{\"PrimaryId\":\"a\",\"Name\":\"Alice\",\"TeamNum\":0,\"bHasCar\":true},{\"PrimaryId\":\"b\",\"Name\":\"Alice\",\"TeamNum\":1,\"bHasCar\":true},{\"PrimaryId\":\"c\",\"Name\":\"Spectator\",\"TeamNum\":255,\"bHasCar\":true},{\"PrimaryId\":\"d\",\"Name\":\"NoCar\",\"TeamNum\":0,\"bHasCar\":false}]}");
            Check(state.Snapshot().Players.Count == 2, "Native overlay must hide spectators and missing cars");
            Check(state.GetPlayer("Alice", "", "", false) == null, "Ambiguous names must not identify a player");
            PlayerState a = state.GetPlayer("Alice", "a");
            PlayerState b = state.GetPlayer("Alice", "b");
            Check(!Object.ReferenceEquals(a, b), "PrimaryId must distinguish duplicate names");
            a.Left = true;
            a.OnField = false;
            sync("{\"Players\":[{\"PrimaryId\":\"a\",\"Name\":\"Alice\",\"TeamNum\":0,\"bHasCar\":true},{\"PrimaryId\":\"b\",\"Name\":\"Renamed\",\"TeamNum\":0,\"bHasCar\":true}]}");
            Check(state.Snapshot().Players.Count == 1, "A stale snapshot cannot undo a leave");
            Check(state.Snapshot().Players[0].Name == "Renamed", "Renames must update the existing PrimaryId");
            Check(Object.ReferenceEquals(b, state.GetPlayer("Renamed", "b")), "Identity must survive a team/name change");
            sync("{\"Players\":[]}");
            Check(state.Snapshot().Players.Count == 0, "Empty field snapshots must remove every live player");
            state.ResetForNewMatch("next");
            sync("{\"Players\":[{\"PrimaryId\":\"a\",\"Name\":\"Alice\",\"TeamNum\":0,\"bHasCar\":true}]}");
            Check(state.Snapshot().Players.Count == 1, "A new match must not inherit leave tombstones");
            typeof(OverlayForm).GetField("stateLock", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, new object());
            typeof(OverlayForm).GetField("serializer", BindingFlags.Instance | BindingFlags.NonPublic).SetValue(form, json);
            MethodInfo handle = typeof(OverlayForm).GetMethod("HandleLiveApiMessage", BindingFlags.Instance | BindingFlags.NonPublic);
            Action<string> send = text => handle.Invoke(form, new object[] { text });
            send("{\"Event\":\"PlayerLeft\",\"Data\":{\"MatchGuid\":\"next\",\"PrimaryId\":\"a\",\"PlayerName\":\"Alice\"}}");
            Check(state.Snapshot().Players.Count == 0, "PlayerLeft must immediately hide the native row");
            send("{\"Event\":\"PlayerJoined\",\"Data\":{\"MatchGuid\":\"next\",\"PrimaryId\":\"a\",\"PlayerName\":\"Alice\"}}");
            Check(state.Snapshot().Players.Count == 0, "PlayerJoined must wait for field confirmation");
            sync("{\"Players\":[{\"PrimaryId\":\"a\",\"Name\":\"Alice\",\"TeamNum\":0,\"bHasCar\":true}]}");
            Check(state.Snapshot().Players.Count == 1, "A joined player with a car must return");
            send("{\"Event\":\"PlayerLeft\",\"Data\":{\"MatchGuid\":\"foreign\",\"PrimaryId\":\"a\",\"PlayerName\":\"Alice\"}}");
            Check(state.Snapshot().Players.Count == 1, "Events for another match must not alter the native field roster");
            Console.WriteLine("Native roster checks passed: " + checks);
        }
    }
}
