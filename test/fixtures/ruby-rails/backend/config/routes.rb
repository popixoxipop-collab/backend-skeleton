Rails.application.routes.draw do
  namespace :api do
    namespace :v1 do
      resources :articles, only: %i[index show create update destroy] do
        member do
          get "preview", to: "articles#preview"
        end
        collection do
          get "featured", to: "articles#featured"
        end
      end
    end
  end

  resource :profile, only: %i[show update], controller: "profiles"
  get "/health", to: "health#show"

  concerns :commentable
  get "/dynamic/#{ENV.fetch('TENANT', 'default')}", to: "health#show"
end
