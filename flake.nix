{
  description = "Bridge media gateway";

  inputs = { nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable"; };

  outputs = { self, nixpkgs }:
    let
      systems =
        [ "x86_64-linux" "aarch64-linux" "x86_64-darwin" "aarch64-darwin" ];
      forAllSystems = f:
        nixpkgs.lib.genAttrs systems
        (system: f nixpkgs.legacyPackages.${system});
    in {
      packages = forAllSystems (pkgs:
        let
          package = pkgs.stdenvNoCC.mkDerivation (finalAttrs: {
            pname = "bridge-media-gateway-fuck-tencent";
            version = "1.0.1";
            src = self;

            pnpmDeps = pkgs.fetchPnpmDeps {
              inherit (finalAttrs) pname version src;
              pnpm = pkgs.pnpm_10;
              fetcherVersion = 3;
              hash = "sha256-zeFvBJscvV+OiAFhczlqhWnGrxi+33HaCi+YbOOIZaw=";
            };

            nativeBuildInputs = with pkgs; [
              nodejs_26
              pnpm_10
              pnpmConfigHook
              makeWrapper
            ];

            buildPhase = ''
              runHook preBuild
              pnpm run build
              runHook postBuild
            '';

            installPhase = ''
              runHook preInstall

              rm -rf node_modules
              pnpm install --offline --frozen-lockfile --prod --ignore-scripts

              mkdir -p $out/lib/bridge-media-gateway $out/bin
              cp -r dist node_modules package.json $out/lib/bridge-media-gateway/

              makeWrapper ${pkgs.nodejs_26}/bin/node $out/bin/bridge-media-gateway \
                --add-flags "$out/lib/bridge-media-gateway/dist/index.js"

              runHook postInstall
            '';

            meta = {
              description = "Media gateway for the QQ/Discord bridge";
              homepage = "https://github.com/AkademiyaEdu/bridge-media-gateway-fuck-tencent";
              mainProgram = "bridge-media-gateway";
              platforms = pkgs.lib.platforms.unix;
            };
          });
        in {
          default = package;
          bridge-media-gateway = package;
        });

      devShells = forAllSystems (pkgs: {
        default = with pkgs;
          mkShell { packages = [ nodejs_26 pnpm_10 git jq ]; };
      });
    };
}
