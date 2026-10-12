import SwiftUI

@main
struct MDLRApp: App {
    var body: some Scene {
        WindowGroup {
            InstrumentView().preferredColorScheme(.dark)
#if os(iOS)
                .statusBarHidden(true)
#endif
        }
    }
}
