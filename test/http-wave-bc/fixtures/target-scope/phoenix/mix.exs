defmodule SbfPhoenixScope.MixProject do
  use Mix.Project

  def project do
    [app: :sbf_phoenix_scope, version: "0.1.0", elixir: "~> 1.15", deps: deps()]
  end

  def application, do: [extra_applications: [:logger]]

  defp deps, do: [{:phoenix, "== 1.8.16"}]
end
