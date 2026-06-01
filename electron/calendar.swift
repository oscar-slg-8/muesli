// ============================================================
// calendar.swift — Lit les événements du calendrier macOS (EventKit)
// Retourne du JSON sur stdout avec les événements du jour.
// Usage : swift calendar.swift [date_iso]
// Si aucune date n'est fournie, utilise aujourd'hui.
// ============================================================

import EventKit
import Foundation

let store = EKEventStore()
let semaphore = DispatchSemaphore(value: 0)

// Demander l'accès au calendrier
if #available(macOS 14.0, *) {
    store.requestFullAccessToEvents { granted, error in
        defer { semaphore.signal() }
        guard granted else {
            let msg = error?.localizedDescription ?? "Accès refusé"
            print("{\"error\": \"\(msg)\", \"events\": []}")
            return
        }
        printEvents(store: store)
    }
} else {
    store.requestAccess(to: .event) { granted, error in
        defer { semaphore.signal() }
        guard granted else {
            let msg = error?.localizedDescription ?? "Accès refusé"
            print("{\"error\": \"\(msg)\", \"events\": []}")
            return
        }
        printEvents(store: store)
    }
}

semaphore.wait()

func printEvents(store: EKEventStore) {
    let calendar = Calendar.current

    // Date cible (argument ou aujourd'hui)
    var targetDate = Date()
    if CommandLine.arguments.count > 1 {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withFullDate]
        if let parsed = formatter.date(from: CommandLine.arguments[1]) {
            targetDate = parsed
        }
    }

    let startOfDay = calendar.startOfDay(for: targetDate)
    let endOfDay = calendar.date(byAdding: .day, value: 1, to: startOfDay)!

    let predicate = store.predicateForEvents(withStart: startOfDay, end: endOfDay, calendars: nil)
    let events = store.events(matching: predicate)

    let formatter = ISO8601DateFormatter()
    formatter.formatOptions = [.withInternetDateTime]

    var results: [[String: Any]] = []
    for event in events {
        var dict: [String: Any] = [
            "id": event.eventIdentifier ?? "",
            "title": event.title ?? "Sans titre",
            "startDate": formatter.string(from: event.startDate),
            "endDate": formatter.string(from: event.endDate),
            "isAllDay": event.isAllDay,
            "calendarName": event.calendar.title
        ]
        if let location = event.location, !location.isEmpty {
            dict["location"] = location
        }
        if let notes = event.notes, !notes.isEmpty {
            dict["notes"] = String(notes.prefix(200))
        }
        if let url = event.url {
            dict["url"] = url.absoluteString
        }
        // Détecter les liens de visio dans les notes ou l'URL
        let allText = "\(event.location ?? "") \(event.notes ?? "") \(event.url?.absoluteString ?? "")"
        let meetingPatterns = ["meet.google.com", "zoom.us", "teams.microsoft.com", "whereby.com", "webex.com", "cal.com"]
        dict["isMeeting"] = meetingPatterns.contains(where: { allText.lowercased().contains($0) })

        // Participants (nom uniquement, exclure l'organisateur si c'est "vous")
        if let participants = event.attendees, !participants.isEmpty {
            let names = participants.compactMap { $0.name }.filter { !$0.isEmpty }
            if !names.isEmpty { dict["attendees"] = names }
        }

        results.append(dict)
    }

    // Trier par heure de début
    results.sort { ($0["startDate"] as? String ?? "") < ($1["startDate"] as? String ?? "") }

    if let jsonData = try? JSONSerialization.data(withJSONObject: ["events": results], options: .prettyPrinted),
       let jsonString = String(data: jsonData, encoding: .utf8) {
        print(jsonString)
    } else {
        print("{\"events\": []}")
    }
}
