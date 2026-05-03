import UIKit

/// UIKit scene lifecycle (required on future iOS); hosts the same `Main` storyboard root as the pre-scene template.
final class SceneDelegate: UIResponder, UIWindowSceneDelegate {
    var window: UIWindow?

    func scene(_ scene: UIScene, willConnectTo session: UISceneSession, options connectionOptions: UIScene.ConnectionOptions) {
        guard let windowScene = scene as? UIWindowScene else { return }
        let storyboard = UIStoryboard(name: "Main", bundle: nil)
        guard let root = storyboard.instantiateInitialViewController() else { return }
        let window = UIWindow(windowScene: windowScene)
        window.rootViewController = root
        self.window = window
        window.makeKeyAndVisible()
    }
}
